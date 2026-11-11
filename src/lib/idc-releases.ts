import { idcError, idcJson, indexVersion, isRecord } from "./idc-http";

const REPO = "https://api.github.com/repos/ImagingDataCommons/idc-index-data";
const WEB = "https://github.com/ImagingDataCommons/idc-index-data";

export function releaseManifest(data: unknown, expected?: string) {
  if (!isRecord(data) || typeof data.tag_name !== "string" || !Array.isArray(data.assets)) idcError("invalid upstream release manifest", 502);
  const version = indexVersion(data.tag_name);
  if (expected && version !== expected) idcError("upstream returned a different index version", 502);
  if (data.draft || data.prerelease) idcError("pre-release or draft indexes require separate review", 409);
  const assets = data.assets.map(asset => {
    if (!isRecord(asset) || typeof asset.name !== "string" || typeof asset.browser_download_url !== "string") idcError("invalid release asset", 502);
    const expectedUrl = `${WEB}/releases/download/${version}/${encodeURIComponent(asset.name)}`;
    if (asset.browser_download_url !== expectedUrl || !/^[A-Za-z0-9_.-]+$/.test(asset.name)) idcError("release asset URL does not match the release", 502);
    return { ...asset, file_sha256: typeof asset.digest === "string" && /^sha256:[a-f0-9]{64}$/.test(asset.digest) ? asset.digest.slice(7) : null };
  });
  return { source: "IDC", index_version: version, idc_release: `v${version.split(".")[0]}`, release_url: `${WEB}/releases/tag/${version}`,
    published_at: data.published_at, release_id: data.id, release_notes: data.body, assets,
    note: "Index package version and IDC data release are distinct. Retain asset checksums. No image content is downloaded by this operation." };
}

export async function idcRelease(params: Record<string, unknown>) {
  for (const name of Object.keys(params)) if (name !== "index_version") idcError(`unsupported release parameter ${name}`);
  const version = params.index_version === undefined ? undefined : indexVersion(params.index_version);
  const url = `${REPO}/releases/${version ? `tags/${version}` : "latest"}`;
  const result = await idcJson(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "bio-mcp-tcia", "X-GitHub-Api-Version": "2022-11-28" } });
  return { ...releaseManifest(result.data, version), source_url: url, retrieved_at: result.retrieved_at, etag: result.etag };
}
