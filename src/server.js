const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT_DIR = path.resolve(__dirname, "..");

function loadLocalEnv(filePath = path.join(ROOT_DIR, ".env")) {
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  content.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;

    const normalized = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const separator = normalized.indexOf("=");
    if (separator < 1) return;

    const key = normalized.slice(0, separator).trim();
    let value = normalized.slice(separator + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  });
}

loadLocalEnv();

const PORT = Number(process.env.PORT || 5173);
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const NODE_MODULES_DIR = path.join(ROOT_DIR, "node_modules");
const DEEPSEEK_API_URL = process.env.DEEPSEEK_API_URL || "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".pdf": "application/pdf"
};

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function readBinaryBody(req, maxBytes = 12_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Resume file is too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function decodeXmlEntities(value) {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractDocxText(buffer) {
  let eocd = -1;
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 65557); index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) throw new Error("Invalid DOCX structure");

  const entries = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let index = 0; index < entries; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    if (name === "word/document.xml") {
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = buffer.subarray(start, start + compressedSize);
      const xmlBuffer = method === 8 ? zlib.inflateRawSync(compressed) : method === 0 ? compressed : null;
      if (!xmlBuffer) throw new Error("Unsupported DOCX compression method");
      const xml = xmlBuffer.toString("utf8");
      return decodeXmlEntities(xml
        .replace(/<w:tab\/?\s*>/g, "\t")
        .replace(/<\/w:p>/g, "\n")
        .replace(/<w:br\/?\s*>/g, "\n")
        .replace(/<[^>]+>/g, ""))
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error("DOCX body was not found");
}

async function handleDocxParse(req, res) {
  try {
    const file = await readBinaryBody(req);
    const text = extractDocxText(file);
    if (text.length < 30) throw new Error("Not enough text was found in the DOCX file");
    sendJson(res, 200, { ok: true, text });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error.message });
  }
}

function buildSystemPrompt(kind) {
  if (kind === "jd-review") {
    return [
      "你是 JobFlow 的 JD Intelligence 岗位分析助手，也是一名熟悉大学生实习求职场景的岗位解读顾问。",
      "",
      "你的任务是基于岗位 JD 回答‘岗位需要什么’，帮助用户快速理解招聘要求。不要生成长篇岗位分析报告，只输出可供后续用户匹配与 Resume Copilot 使用的结构化信息。",
      "",
      "分析原则：",
      "1. 核心能力提取 3-5 个，每项只包含能力名称和一句话作用解释。",
      "2. 核心能力按 P0、P1、P2 排序：P0 是招聘重点考察的岗位核心能力，P1 是影响岗位表现的重要能力，P2 是提高竞争优势的加分能力。",
      "3. 技能关键词总数控制在 5-8 个，仅输出关键词，不进行解释，去重后按 P0、P1、P2 排序。",
      "4. 岗位职责提取 3-6 项，保留 JD 原始含义，并按 JD 中出现频率和岗位重要程度从高到低排序：高频出现、体现岗位核心能力的职责优先，低频辅助职责靠后。",
      "5. responsibility 只写精炼的职责名称，不使用 P0/P1/P2 标签，不添加括号、排序依据、能力说明或其他解释。",
      "6. 岗位解析结论用 2-3 句话概括核心能力、应重点展示的经历方向和求职准备重点。",
      "7. 避免重复 JD 原文；避免职业发展建议；不要分析用户匹配情况；不要修改简历。",
      "8. 当前功能边界只有：JD 理解 → 岗位要求提炼。",
      "9. 输出必须是 JSON，不要输出 Markdown，不要添加 JSON 以外的解释。",
      "",
      "字段要求：",
      "- priority 只能使用 P0、P1、P2。",
      "- description 必须是一句话，直接解释能力在岗位中的作用。",
      "- responsibility 必须是职责名称本身，按重要程度排好顺序，不得包含括号解释。",
      "- conclusion 必须是 2-3 句话的字符串，不要分点，不要加入用户匹配或简历修改内容。",
      "",
      "请严格返回以下 JSON 结构：",
      "{",
      "  \"coreCapabilities\": [",
      "    {",
      "      \"name\": \"能力名称\",",
      "      \"priority\": \"P0 / P1 / P2\",",
      "      \"description\": \"一句话解释该能力在岗位中的作用\"",
      "    }",
      "  ],",
      "  \"skillKeywords\": [",
      "    { \"priority\": \"P0\", \"keywords\": [\"关键词\"] },",
      "    { \"priority\": \"P1\", \"keywords\": [\"关键词\"] },",
      "    { \"priority\": \"P2\", \"keywords\": [\"关键词\"] }",
      "  ],",
      "  \"responsibilityBreakdown\": [",
      "    {",
      "      \"responsibility\": \"精炼的岗位职责名称\"",
      "    }",
      "  ],",
      "  \"conclusion\": \"用 2-3 句话概括核心能力、应重点展示的经历方向和求职准备重点\"",
      "}"
    ].join("\n");
  }

  if (kind === "resume-review") {
    return [
      "你是 JobFlow 的 Resume Copilot。你的任务是基于用户已有简历内容，结合目标岗位 JD，提供简历表达优化建议。",
      "Resume Copilot 回答‘我的简历如何更匹配’，不重复 JD Intelligence 对‘岗位需要什么’的分析。",
      "",
      "生成规则：",
      "1. 保留用户原始简历，不生成整份新简历，不直接覆盖原文，不要求用户新增不存在的经历。",
      "2. 每条批注必须对应简历中的一段完整原文，original 必须尽量与输入简历保持完全一致，便于页面高亮定位。",
      "3. optimizationType 只允许‘经历表达优化’或‘岗位匹配优化’，不得生成其他类型。",
      "4. 经历表达优化用于提升已有经历的表达质量：判断是否只是罗列职责、是否缺少关键行动、必要结果或体现能力的信息。不要强制每条内容完整符合 STAR；实习经历重点看行动和成果，科研经历重点看研究问题、方法和发现，项目经历重点看任务、贡献和结果。",
      "5. 岗位匹配优化用于判断已有经历是否充分体现岗位核心能力、岗位相关语言和 JD 关键要求。只强化已有经历与岗位的关联表达，不要求新增经历。",
      "6. problem 具体说明当前原文存在的问题，不超过 36 个中文字符；suggestion 提供与该问题直接对应的优化方向，不超过 42 个中文字符。两者不得错位，不输出 why、reason、finding、问题标签或重复的 JD 分析。",
      "7. 建议必须基于原文中已有信息，优先使用‘具体化、重组、强化、突出’等表达；不得直接要求加入简历未出现的具体数字、工具、行动或结果。",
      "8. suggestion 禁止出现‘例如’、‘如XX’、‘XX人’、占位符、虚构示例或简历未出现的工具与指标。需要用户核实现有经历细节时，只能使用‘如确有相关信息，可进一步明确……’并保持可选。",
      "9. 每段原文最多生成一条最重要的批注，优先输出 2-5 条高价值建议，避免为了数量重复批注。",
      "10. fitScore 表示简历评分，范围为 0-100，必须基于岗位要求和简历内容判断。",
      "11. 输入简历中的“第 N 页”标记仅用于判断页码；pageHint 返回原文所在页码，无法判断时返回 null。",
      "12. 只返回合法 JSON，不要输出 Markdown 或 JSON 之外的内容。",
      "",
      "严格返回以下结构：",
      "{",
      "  \"fitScore\": 0-100 的整数,",
      "  \"paragraphIssues\": [",
      "    {",
      "      \"optimizationType\": \"经历表达优化 / 岗位匹配优化\",",
      "      \"problem\": \"具体说明当前原文存在的问题\",",
      "      \"original\": \"简历中需要处理的完整原文\",",
      "      \"pageHint\": 1,",
      "      \"suggestion\": \"针对当前问题的具体优化方向\"",
      "    }",
      "  ]",
      "}"
    ].join("\n");
  }

  if (kind === "jd-match") {
    return [
      "你是 JobFlow 的岗位匹配分析助手。",
      "请基于岗位 JD、已经生成的岗位解析和用户真实简历，分析用户与岗位的匹配情况，回答‘我和岗位差在哪里’。",
      "",
      "分析规则：",
      "1. 输出 0-100 的整体匹配度，并分别评估能力匹配、经历匹配和技能匹配。",
      "2. 每项评分必须基于 JD 要求和用户简历中的真实证据；证据不足时应降低评分并明确说明，不要凭空打分。",
      "3. 已匹配优势必须把岗位要求与用户的具体经历对应起来，不生成无依据优势。",
      "4. 能力缺口提取 2-4 项，必须总结用户简历中缺少或证据不足的关键能力，不得直接复制 JD 的要求原句。",
      "5. 每项能力缺口只包含简洁的能力名称和一句简短说明；说明必须基于简历现有内容，指出缺少的能力证据。",
      "6. 能力缺口按岗位重要程度从高到低排序，priority 仅用于内部排序，依次使用 P0、P1、P2。",
      "7. 不生成简历修改建议、求职优化建议或职业规划建议，不重复岗位解析内容。",
      "8. 只返回合法 JSON，不要输出 Markdown 或 JSON 之外的解释。",
      "",
      "严格返回以下 JSON 结构：",
      "{",
      "  \"matchScore\": {",
      "    \"overall\": 74,",
      "    \"dimensions\": [",
      "      { \"name\": \"能力匹配\", \"score\": 80, \"basis\": \"基于岗位核心能力和简历证据说明评分依据\" },",
      "      { \"name\": \"经历匹配\", \"score\": 75, \"basis\": \"基于项目、实习或活动经历说明评分依据\" },",
      "      { \"name\": \"技能匹配\", \"score\": 65, \"basis\": \"基于专业技能和工具技能说明评分依据\" }",
      "    ]",
      "  },",
      "  \"matchedStrengths\": [",
      "    { \"requirement\": \"用户满足的岗位能力或要求\", \"matchReason\": \"基于用户真实经历说明满足原因\" }",
      "  ],",
      "  \"gaps\": [",
      "    { \"gap\": \"关键能力缺口名称\", \"priority\": \"P0 / P1 / P2\", \"gapReason\": \"基于简历证据的一句话简短说明\" }",
      "  ]",
      "}"
    ].join("\n");
  }

  if (kind === "jd-directions") {
    return [
      "你是 JobFlow 的岗位竞争力提升助手。",
      "请基于岗位 JD、岗位解析、用户真实简历和用户匹配结果中的能力缺口，帮助用户明确提升岗位竞争力的方向。",
      "该模块不负责简历修改，只提供优化思路，后续由 Resume Copilot 执行具体修改。",
      "",
      "生成规则：",
      "1. 每条建议必须与用户匹配中的一个能力缺口一一对应，并严格保持能力缺口的排序。",
      "2. problem 使用具体、简短的问题类型，必须与 explanation 描述的是同一个问题，禁止标题与解释错位。",
      "3. explanation 必须结合用户当前简历说明不足，只写一句话，不超过 45 个中文字符，不能重复问题标题。",
      "4. direction 必须直接回应左侧问题，使用“补充”“量化”“梳理”“强化”等动作型短语开头，只写一句话，不超过 45 个中文字符。",
      "5. priority 沿用对应能力缺口的优先级，仅用于内部排序；不要生成 relatedRequirement、能力标签或其他标签字段。",
      "6. 左侧明确说明存在什么问题，右侧明确说明应该提升什么，避免两列表达重复。",
      "7. 不直接生成修改后的简历内容，不生成通用简历写作建议或职业规划建议。",
      "8. 不重复用户匹配模块中的优势和缺口原文，应在缺口基础上形成下一步思路。",
      "9. 只返回合法 JSON，不要输出 Markdown 或 JSON 之外的解释。",
      "",
      "严格返回以下 JSON 结构：",
      "{",
      "  \"improvements\": [",
      "    {",
      "      \"problem\": \"简短的问题标题\",",
      "      \"priority\": \"P0 / P1 / P2\",",
      "      \"explanation\": \"一句话说明当前不足，不超过45字\",",
      "      \"direction\": \"动作型短语开头的一句话提升方向，不超过45字\"",
      "    }",
      "  ]",
      "}"
    ].join("\n");
  }

  if (kind === "resume-polish") {
    return [
      "你是 JobFlow Resume Copilot 的 AI 优化表达助手。",
      "请基于原简历已有内容，结合目标岗位要求和用户可选补充的真实信息，生成一段可由用户确认后替换原文的经历表达。",
      "不得新增用户未提供的数字、结果、工具、职责或经历；信息不足时使用克制表达，不要补造事实。",
      "用户没有补充信息时，只重组和优化原文已有内容，不得要求或暗示用户必须新增经历。",
      "根据经历类型选择表达重点：实习突出行动和成果，科研突出研究问题、方法和发现，项目突出任务、贡献和结果；不要机械套用完整 STAR。",
      "表达应简洁、专业，并自然强化与目标岗位相关的已有能力和语言。",
      "只优化当前批注对应的原文，不扩写其他经历，不生成整份简历。",
      "只返回 JSON，不要输出 Markdown。",
      "返回结构：{\"revised\": \"优化后的经历表达\", \"reason\": \"本次优化如何增强岗位相关性和证明力\"}"
    ].join("\n");
  }

  return [
    "你是 JobFlow 的求职 Workspace 助手。",
    "请根据岗位上下文回答用户问题，只返回 JSON。",
    "返回结构：{\"answer\": \"回答内容\"}"
  ].join("\n");
}

async function callDeepSeek(kind, payload) {
  loadLocalEnv();
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return { mocked: true, data: mockResponse(kind, payload) };
  }

  const content = JSON.stringify(payload, null, 2);
  const response = await fetch(DEEPSEEK_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: buildSystemPrompt(kind) },
        { role: "user", content }
      ]
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`DeepSeek request failed: ${response.status} ${text}`);
  }

  const json = await response.json();
  const message = json.choices?.[0]?.message?.content || "{}";
  return { mocked: false, data: JSON.parse(message) };
}

async function testDeepSeekConnection() {
  loadLocalEnv();
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return { ok: false, configured: false, provider: "DeepSeek", model: DEEPSEEK_MODEL, error: "DEEPSEEK_API_KEY 未配置" };
  }

  const startedAt = Date.now();
  const response = await fetch(DEEPSEEK_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      temperature: 0,
      max_tokens: 12,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "只返回合法 JSON。" },
        { role: "user", content: "返回 {\"status\":\"ok\"}" }
      ]
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`DeepSeek 连接失败：${response.status} ${detail}`);
  }

  await response.json();
  return {
    ok: true,
    configured: true,
    provider: "DeepSeek",
    model: DEEPSEEK_MODEL,
    latencyMs: Date.now() - startedAt
  };
}

function mockResponse(kind, payload = {}) {
  if (kind === "jd-review") {
    return {
      coreCapabilities: [
        {
          name: "活动运营能力",
          priority: "P0",
          description: "能够围绕业务目标完成活动策划、执行推进和效果复盘。"
        },
        {
          name: "数据分析",
          priority: "P0",
          description: "能够跟踪关键指标，并通过数据判断运营动作是否有效。"
        },
        {
          name: "沟通协作",
          priority: "P1",
          description: "能够协同产品和运营团队推进任务按计划落地。"
        }
      ],
      skillKeywords: [
        { priority: "P0", keywords: ["活动运营", "数据分析", "用户增长"] },
        { priority: "P1", keywords: ["项目推进", "效果复盘", "跨团队协作"] },
        { priority: "P2", keywords: ["Excel"] }
      ],
      responsibilityBreakdown: [
        {
          responsibility: "负责运营活动的策划、执行与复盘",
          specificWork: "围绕活动目标制定方案，协调资源推动上线，跟踪数据并输出复盘结论。"
        },
        {
          responsibility: "协同产品和运营团队提升转化率",
          specificWork: "同步业务问题与优化需求，跟进协作事项，并结合数据验证优化效果。"
        }
      ],
      conclusion: "该岗位核心关注活动运营闭环和数据分析能力，同时要求候选人能够协同团队推进项目。求职者应重点展示活动策划执行、数据复盘和跨团队协作相关经历，并熟悉岗位 JD 中出现的关键工具与业务指标。"
    };
  }

  if (kind === "jd-match") {
    return {
      matchScore: {
        overall: 74,
        dimensions: [
          { name: "能力匹配", score: 80, basis: "校园活动与社群经历体现了活动运营和协作推进能力，但数据分析证据仍不完整。" },
          { name: "经历匹配", score: 75, basis: "已有活动组织和项目协作经历，可对应部分岗位职责，但缺少完整运营闭环案例。" },
          { name: "技能匹配", score: 65, basis: "简历体现了基础运营执行能力，但对 Excel、指标分析和复盘方法的描述较少。" }
        ]
      },
      matchedStrengths: [
        {
          requirement: "活动运营能力",
          matchReason: "校园活动组织经历体现了活动策划、用户触达和运营执行经验。"
        },
        {
          requirement: "跨团队协作",
          matchReason: "项目协作经历能够证明信息同步、任务跟进和共同推进交付的能力。"
        }
      ],
      gaps: [
        {
          gap: "数据分析能力",
          priority: "P0",
          gapReason: "已有项目经历，但简历中缺少数据指标、分析方法和结果体现。"
        },
        {
          gap: "运营闭环经验",
          priority: "P1",
          gapReason: "当前经历未能证明从目标拆解、执行推进到效果复盘的完整工作过程。"
        }
      ]
    };
  }

  if (kind === "jd-directions") {
    return {
      improvements: [
        {
          problem: "缺少数据分析能力证明",
          priority: "P0",
          explanation: "岗位要求能够通过数据判断运营效果，但当前经历中缺少数据指标、分析方法和结果体现。",
          direction: "补充能够证明数据分析能力的真实经历，重点呈现分析过程、使用方法和最终结果。"
        },
        {
          problem: "运营闭环经验不完整",
          priority: "P1",
          explanation: "当前经历能够证明活动执行，但尚未体现从目标拆解、推进落地到效果复盘的完整过程。",
          direction: "优先梳理覆盖目标、行动、协作和复盘环节的项目经历，形成完整的运营闭环证据。"
        }
      ]
    };
  }

  if (kind === "resume-review") {
    return {
      fitScore: 72,
      matched: ["有项目经历基础", "具备一定协作表达"],
      missing: ["结果量化不足", "岗位关键词出现较少"],
      strengthen: ["把项目影响写清楚", "补充数据指标", "突出与 JD 对应的能力"],
      weaken: ["弱化纯执行描述"],
      priority: ["先改最近一段核心经历", "再补充技能关键词", "最后统一语言风格"],
      paragraphIssues: [
        {
          optimizationType: "经历表达优化",
          problem: "当前经历主要描述负责内容，未体现具体行动和实际贡献。",
          original: "负责社群运营和活动执行。",
          suggestion: "在已有经历范围内强化负责内容、执行方法和可确认的项目结果。"
        },
        {
          optimizationType: "岗位匹配优化",
          problem: "当前经历提到数据复盘，但未突出目标岗位关注的数据分析过程。",
          original: "定期整理活动数据并进行复盘。",
          suggestion: "强化已有经历中的指标跟踪、分析方法和复盘后采取的调整。"
        }
      ]
    };
  }

  if (kind === "resume-polish") {
    const supplement = String(payload.supplement || "").trim();
    return {
      revised: supplement
        ? `围绕社群用户需求推进日常运营与活动执行，${supplement.replace(/[。；;]+$/g, "")}，并结合结果复盘持续优化后续运营动作。`
        : "围绕社群用户需求推进日常运营与活动执行，并结合结果复盘持续优化后续运营动作。",
      reason: "保留用户提供的真实信息，并按‘行动、方法、结果’组织表达，使经历与岗位关注的运营闭环更直接对应。"
    };
  }

  return {
    answer: "我建议先把这段经历改成“动作 + 方法 + 结果”的结构，让它更贴合岗位能力要求。",
    revisions: [
      {
        original: "负责社群运营和活动执行。",
        revised: "负责 3 个求职社群的日常运营，围绕用户求职阶段设计内容触达和活动提醒，提升活动参与度与社群活跃度。",
        reason: "补充了负责范围、具体动作和业务结果，比原句更适合投递运营/增长类岗位。",
        relatedCapability: "用户运营 / 增长执行"
      }
    ]
  };
}

async function handleApi(req, res) {
  try {
    const raw = await readBody(req);
    const payload = raw ? JSON.parse(raw) : {};
    const kind = req.url.replace("/api/", "");
    const result = await callDeepSeek(kind, payload);
    sendJson(res, 200, { ok: true, ...result });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message });
  }
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  const vendorFiles = {
    "/vendor/lucide.js": path.join(NODE_MODULES_DIR, "lucide", "dist", "umd", "lucide.min.js"),
    "/vendor/pdf-lib.js": path.join(NODE_MODULES_DIR, "pdf-lib", "dist", "pdf-lib.min.js"),
    "/vendor/pdfjs/pdf.mjs": path.join(NODE_MODULES_DIR, "pdfjs-dist", "build", "pdf.min.mjs"),
    "/vendor/pdfjs/pdf.worker.mjs": path.join(NODE_MODULES_DIR, "pdfjs-dist", "build", "pdf.worker.min.mjs")
  };
  if (vendorFiles[urlPath]) {
    fs.readFile(vendorFiles[urlPath], (error, data) => {
      if (error) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      res.writeHead(200, { "Content-Type": mimeTypes[path.extname(vendorFiles[urlPath])] || "application/octet-stream" });
      res.end(data);
    });
    return;
  }
  const safePath = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      fs.readFile(path.join(PUBLIC_DIR, "index.html"), (fallbackError, fallbackData) => {
        if (fallbackError) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        res.writeHead(200, { "Content-Type": mimeTypes[".html"] });
        res.end(fallbackData);
      });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.url === "/api/ai-status" && req.method === "GET") {
    loadLocalEnv();
    sendJson(res, 200, {
      ok: true,
      configured: Boolean(process.env.DEEPSEEK_API_KEY),
      provider: "DeepSeek",
      model: DEEPSEEK_MODEL,
      mode: process.env.DEEPSEEK_API_KEY ? "live" : "mock"
    });
    return;
  }
  if (req.url === "/api/ai-status/test" && req.method === "POST") {
    testDeepSeekConnection()
      .then(result => sendJson(res, result.ok ? 200 : 400, result))
      .catch(error => sendJson(res, 502, {
        ok: false,
        configured: Boolean(process.env.DEEPSEEK_API_KEY),
        provider: "DeepSeek",
        model: DEEPSEEK_MODEL,
        error: error.message
      }));
    return;
  }
  if (req.url === "/api/parse-docx" && req.method === "POST") {
    handleDocxParse(req, res);
    return;
  }
  if (req.url.startsWith("/api/") && req.method === "POST") {
    handleApi(req, res);
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`JobFlow is running at http://localhost:${PORT}`);
  if (process.env.DEEPSEEK_API_KEY) {
    console.log(`DeepSeek live mode is enabled (${DEEPSEEK_MODEL}).`);
  } else {
    console.log("DEEPSEEK_API_KEY is not set. The app will use mock AI responses.");
  }
});
