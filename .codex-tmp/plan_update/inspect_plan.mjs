import fs from "node:fs/promises";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const inputPath = "/Users/macbook/Desktop/国贸数字2026暑假/Demo App 专属健身饮食秘书/计划表/Demo_App_计划表_(初表).xlsx";
const outDir = "/Users/macbook/Documents/AI饮食秘书/.codex-tmp/plan_update";
const input = await FileBlob.load(inputPath);
const workbook = await SpreadsheetFile.importXlsx(input);

const overview = await workbook.inspect({
  kind: "workbook,sheet,table,region",
  maxChars: 12000,
  tableMaxRows: 60,
  tableMaxCols: 20,
  tableMaxCellChars: 120,
});
await fs.writeFile(`${outDir}/overview.ndjson`, overview.ndjson, "utf8");

const sheets = await workbook.inspect({ kind: "sheet", include: "id,name", maxChars: 3000 });
await fs.writeFile(`${outDir}/sheets.ndjson`, sheets.ndjson, "utf8");
const rows = sheets.ndjson
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line))
  .filter((entry) => entry.kind === "sheet");
for (const row of rows) {
  const preview = await workbook.render({ sheetName: row.name, autoCrop: "all", scale: 1.5, format: "png" });
  await fs.writeFile(`${outDir}/${row.name.replaceAll(/[^\w\-]+/g, "_")}.png`, new Uint8Array(await preview.arrayBuffer()));
}
