import fs from "node:fs/promises";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const inputPath = "/Users/macbook/Desktop/国贸数字2026暑假/Demo App 专属健身饮食秘书/计划表/Demo_App_计划表_(初表).xlsx";
const outputDir = "/Users/macbook/Documents/AI饮食秘书/outputs/plan_update_20260827";
const outputPath = `${outputDir}/Demo_App_计划表_8月27日更新.xlsx`;

const input = await FileBlob.load(inputPath);
const workbook = await SpreadsheetFile.importXlsx(input);
const sheet = workbook.worksheets.getItem("两月实习计划表");

sheet.getRange("A1").values = [["Demo App计划表（8/27更新）"]];
sheet.getRange("A2").values = [["7/09-9/04（截至8/27）"]];

sheet.getRange("C12:G12").values = [[
  "开发完善+验收",
  "1）完善饮食咨询网页、对话流程和基础安全检查\n2）补齐长期档案、初始计划、续期提醒、建议记录等后端能力\n3）完成本地知识库检索和PubMed文献预筛选工具\n4）完成 PostgreSQL / LangGraph 双实例、回滚、备份等验收",
  "1）可运行网页端Demo\n2）后端服务与用户数据能力\n3）本地知识库交叉验证工具\n4）PubMed文献自动抓取+预筛选工具\n5）预生产观察验收材料",
  "截至8/27：\n1）核心功能已实现\n2）独立预生产观察通过（100个真实请求）",
  "主线已从“运营+APP”调整为把Demo和后端能力补齐。\n正式全量切换暂不做，先继续稳定性观察。",
]];

sheet.getRange("D13:G13").values = [[
  "1）整理项目成果、文档和测试记录\n2）补充后续优化清单\n3）准备向导师汇报",
  "项目总结、Demo说明、后续优化清单",
  "项目总结/导师汇报",
  "后续优先做：真实用户测试、内容优化、知识库持续更新。",
]];

sheet.getRange("D12:G13").format.wrapText = true;
sheet.getRange("A12:G12").format.rowHeight = 122;
sheet.getRange("A13:G13").format.rowHeight = 95;

await fs.mkdir(outputDir, { recursive: true });
const check = await workbook.inspect({
  kind: "table",
  range: "两月实习计划表!A1:G14",
  include: "values,formulas",
  tableMaxRows: 14,
  tableMaxCols: 7,
});
await fs.writeFile(`${outputDir}/verification.ndjson`, check.ndjson, "utf8");

const preview = await workbook.render({
  sheetName: "两月实习计划表",
  range: "A1:G14",
  scale: 1.5,
  format: "png",
});
await fs.writeFile(`${outputDir}/preview.png`, new Uint8Array(await preview.arrayBuffer()));

const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);
console.log(outputPath);
