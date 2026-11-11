import { expect, it } from "vitest";
import { idcCompleteness } from "./idc-completeness";

it.each([
  [{ _idc: {}, truncated: true, row_count: 20 }, false, "upstream_cap"],
  [{ _idc: {}, truncated: false, row_count: 0 }, true, undefined],
  [{ _idc: {}, returned: 2, total_series: 45, page: 0 }, false, "page_limit"],
  [{ _idc: {}, returned: 0, total_series: 45, page: 50 }, false, "page_limit"],
  [{ _idc: {}, returned: 45, total_series: 45, page: 0 }, true, undefined],
  [{ _idc: {}, manifest_text: "s3://bucket/prefix/*\n" }, false, "unknown"],
  [{ _idc_objects: {}, files: [], pagination: { has_more: true, page_token: null } }, false, "page_limit"],
  [{ _idc_objects: {}, files: [{}], pagination: { has_more: false, page_token: "last" } }, false, "page_limit"],
  [{ _idc_objects: {}, files: [], pagination: { has_more: false, page_token: null } }, true, undefined],
])("keeps provider coverage separate from successful storage %#", (data, complete, reason) => {
  const result = idcCompleteness(data);
  expect(result?.complete).toBe(complete);
  expect(result?.truncation?.reason).toBe(reason);
});

it("does not infer completeness from unrelated metadata", () => {
  expect(idcCompleteness({ stats: 5 })).toBeUndefined();
  expect(idcCompleteness({ _idc: {}, counts: { series: 5 } })).toBeUndefined();
});
