import { expect, it, vi } from "vitest";
import { detectArrays, inferSchema, type SchemaHints } from "@bio-mcp/shared/staging/schema-inference";
vi.mock("@bio-mcp/shared/staging/rest-staging-do", () => ({ RestStagingDO: class {} }));
import { TciaDataDO } from "./do";

it("materializes IDC series and auxiliary arrays under separate names", () => {
  const payload = { _idc: { version: "fixture" }, series: [{ SeriesInstanceUID: "1.2.3", PatientID: "001", Modality: "CT" }], warnings: [{ message: "fixture" }] };
  const hints = (TciaDataDO.prototype as unknown as { getSchemaHints: (data: unknown) => SchemaHints }).getSchemaHints(payload);
  const schema = inferSchema(detectArrays(payload), hints);
  expect(schema.tables.map(table => table.name)).toEqual(["series", "warnings"]);
  expect(schema.tables[0].columns.map(column => column.name)).toContain("PatientID");
});
