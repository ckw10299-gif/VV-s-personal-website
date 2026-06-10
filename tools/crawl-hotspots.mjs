import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const OUTPUT_PATH = resolve("assets/hotspots/weekly.json");
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36";

const meta = {
  generatedAt: new Date().toISOString(),
  week: previousWeekLabel(),
  sources: [],
  warnings: []
};

const items = [];

await collect("抖音", collectDouyin);
await collect("小红书", collectXiaohongshu);

const payload = {
  meta,
  items,
  updatedAt: new Date().toISOString()
};

await mkdir(dirname(OUTPUT_PATH), { recursive: true });
await writeFile(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

console.log(`Wrote ${items.length} hotspot rows to ${OUTPUT_PATH}`);

async function collect(platform, collector) {
  try {
    const rows = await collector();
    rows.slice(0, 12).forEach((row, index) => {
      items.push({
        id: `auto-${meta.week}-${platform}-${index + 1}`,
        week: meta.week,
        platform,
        type: row.type || "热梗",
        title: row.title,
        originTitle: row.originTitle || row.title,
        originUrl: row.originUrl || searchUrl(platform, row.title),
        imitation: row.imitation || "",
        imitationUrl: row.imitationUrl || "",
        note: row.note || "自动抓取自公开热榜；起源与模仿案例建议人工复核补充。",
        createdAt: Date.now() - index,
        updatedAt: Date.now()
      });
    });
    meta.sources.push({ platform, status: "ok", count: rows.length });
  } catch (error) {
    meta.sources.push({ platform, status: "failed", message: error.message });
    meta.warnings.push(`${platform}: ${error.message}`);
  }
}

async function collectDouyin() {
  const candidates = [
    "https://www.iesdouyin.com/web/api/v2/hotsearch/billboard/word/",
    "https://www.douyin.com/aweme/v1/web/hot/search/list/?device_platform=webapp&aid=6383&channel=channel_pc_web"
  ];
  const data = await fetchFirstJson(candidates, "https://www.douyin.com/");
  const rawList = data?.word_list || data?.data?.word_list || data?.data || [];
  const rows = normalizeRows(rawList, ["word", "sentence", "title", "word_cover"]);
  if (!rows.length) throw new Error("未解析到抖音热榜数据");
  return rows.map((row) => ({
    ...row,
    note: row.hot ? `热度：${row.hot}。自动抓取自抖音公开热榜。` : "自动抓取自抖音公开热榜。"
  }));
}

async function collectXiaohongshu() {
  const candidates = [
    "https://edith.xiaohongshu.com/api/sns/web/v1/search/hotlist"
  ];
  const data = await fetchFirstJson(candidates, "https://www.xiaohongshu.com/");
  const rawList = data?.data?.items || data?.data?.hot_list || data?.data || [];
  const rows = normalizeRows(rawList, ["title", "query", "name", "word"]);
  if (!rows.length) throw new Error("未解析到小红书热榜数据");
  return rows.map((row) => ({
    ...row,
    note: row.hot ? `热度：${row.hot}。自动抓取自小红书公开热榜。` : "自动抓取自小红书公开热榜。"
  }));
}

async function fetchFirstJson(urls, referer) {
  const errors = [];
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: "application/json,text/plain,*/*",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
          referer,
          "user-agent": USER_AGENT
        }
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.json();
    } catch (error) {
      errors.push(`${url}: ${error.message}`);
    }
  }
  throw new Error(errors.join(" | "));
}

function normalizeRows(rawList, titleKeys) {
  const list = Array.isArray(rawList) ? rawList : [];
  return list
    .map((entry) => {
      const source = entry?.word_info || entry?.word || entry;
      const title = typeof source === "string"
        ? source
        : titleKeys.map((key) => source?.[key]).find(Boolean);
      const hotSource = typeof source === "string" ? entry : source;
      const hot = hotSource?.hot_value || hotSource?.hot || hotSource?.score || hotSource?.views || "";
      return title ? {
        title: String(title).trim(),
        originTitle: String(title).trim(),
        hot
      } : null;
    })
    .filter(Boolean);
}

function previousWeekLabel() {
  const now = shanghaiDate(new Date());
  now.setDate(now.getDate() - 7);
  return weekRangeLabel(now);
}

function weekRangeLabel(date) {
  const day = (date.getDay() + 6) % 7;
  const start = new Date(date);
  start.setDate(date.getDate() - day);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return `${start.getMonth() + 1}.${start.getDate()}-${end.getMonth() + 1}.${end.getDate()}`;
}

function shanghaiDate(date) {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000);
}

function searchUrl(platform, title) {
  const query = encodeURIComponent(title);
  return platform === "小红书"
    ? `https://www.xiaohongshu.com/search_result?keyword=${query}`
    : `https://www.douyin.com/search/${query}`;
}
