"""Import every Parquet asset from a pinned IDC release into a new local SQLite file.

Reads previously downloaded files only. No network, DICOM retrieval or backend service.
Native ordered JSON rows and Arrow schemas remain authoritative; SQL views expose cells.
"""

import argparse
import base64
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import tempfile
import time


RELEASES = "https://github.com/ImagingDataCommons/idc-index-data/releases"


def quoted(name):
    return '"' + name.replace('"', '""') + '"'


def check_deadline(deadline):
    if time.monotonic() > deadline:
        raise ValueError("Import deadline exceeded")


def fingerprint(stream):
    info = os.fstat(stream.fileno())
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def file_hash(stream, deadline, expected_size):
    stream.seek(0)
    digest = hashlib.sha256()
    size = 0
    while block := stream.read(1024 * 1024):
        check_deadline(deadline)
        size += len(block)
        if size > expected_size:
            raise ValueError("Source artifact exceeded its declared size")
        digest.update(block)
    if size != expected_size:
        raise ValueError("Source artifact differs from its declared size")
    stream.seek(0)
    return digest.hexdigest()


def release_manifest(options):
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", options.index_version):
        raise ValueError("An exact numeric index package version is required")
    if not re.fullmatch(r"[a-f0-9]{64}", options.expected_manifest_sha256):
        raise ValueError("Expected manifest SHA-256 must be lowercase hexadecimal")
    with Path(options.release_manifest).open("rb") as stream:
        raw = stream.read(2 * 1024 * 1024 + 1)
    if len(raw) > 2 * 1024 * 1024:
        raise ValueError("Release manifest exceeds 2 MiB")
    digest = hashlib.sha256(raw).hexdigest()
    if digest != options.expected_manifest_sha256:
        raise ValueError("Release manifest SHA-256 mismatch")
    data = json.loads(raw)
    version = options.index_version
    if (not isinstance(data, dict) or data.get("tag_name") != version
            or data.get("html_url") != f"{RELEASES}/tag/{version}"
            or data.get("draft") is not False or data.get("prerelease") is not False
            or not isinstance(data.get("assets"), list)):
        raise ValueError("Expected a stable official IDC release manifest for the selected version")
    assets, names = [], set()
    for asset in data["assets"]:
        if not isinstance(asset, dict) or not isinstance(asset.get("name"), str):
            raise ValueError("Malformed release asset")
        name = asset["name"]
        if name in names:
            raise ValueError("Duplicate release asset name")
        names.add(name)
        if not name.endswith(".parquet"):
            continue
        if (not re.fullmatch(r"[a-z][a-z0-9_]*\.parquet", name)
                or name.startswith(("sqlite_", "_idc"))
                or asset.get("browser_download_url") != f"{RELEASES}/download/{version}/{name}"
                or not isinstance(asset.get("digest"), str)
                or not re.fullmatch(r"sha256:[a-f0-9]{64}", asset["digest"])
                or type(asset.get("size")) is not int or asset["size"] <= 0):
            raise ValueError("Invalid Parquet asset identity, checksum or size")
        assets.append(asset)
    if not assets or len(assets) > 100 or sum(a["size"] for a in assets) > options.max_source_bytes:
        raise ValueError("Parquet asset count or total source byte bound exceeded")
    tables = ["index" if a["name"] == "idc_index.parquet" else a["name"][:-8] for a in assets]
    if len(set(tables)) != len(tables):
        raise ValueError("Release assets would collide in SQLite")
    return raw.decode("utf-8"), digest, sorted(assets, key=lambda a: a["name"])


def validate_schema(schema, version):
    import pyarrow as pa

    def supported(field_type):
        if pa.types.is_struct(field_type):
            fields = list(field_type)
            return (len({field.name for field in fields}) == len(fields)
                    and all(supported(field.type) for field in fields))
        if pa.types.is_list(field_type) or pa.types.is_large_list(field_type):
            return supported(field_type.value_type)
        return (pa.types.is_string(field_type) or pa.types.is_large_string(field_type)
                or pa.types.is_integer(field_type) or pa.types.is_boolean(field_type)
                or pa.types.is_floating(field_type) or pa.types.is_null(field_type))

    names = schema.names
    if (not names or len(names) > 1000 or any(not name or "\x00" in name for name in names)
            or len({name.casefold() for name in names}) != len(names)):
        raise ValueError("Unsupported or duplicate column names")
    if not all(supported(field.type) for field in schema):
        raise ValueError("Unsupported Arrow cell type or duplicate nested field")
    observed = (schema.metadata or {}).get(b"idc_index_data_version", b"").decode("utf-8")
    if not re.fullmatch(re.escape(version) + r"(?:-[0-9]+-g[0-9a-f]+)?", observed):
        raise ValueError("Parquet metadata does not match the selected index version")
    return observed


def create_table(connection, table, names):
    storage = "_idc_rows_" + table
    connection.execute(f"CREATE TABLE {quoted(storage)} (row_index INTEGER PRIMARY KEY, native_json TEXT NOT NULL)")
    projections = [f"json_extract(native_json, '$[{i}]') AS {quoted(name)}" for i, name in enumerate(names)]
    connection.execute(f"CREATE VIEW {quoted(table)} AS SELECT {', '.join(projections)} FROM {quoted(storage)}")
    return storage


def import_rows(connection, parquet, storage, options, budget, deadline):
    count, ordered_hash = 0, hashlib.sha256()
    for batch in parquet.iter_batches(batch_size=512):
        check_deadline(deadline)
        if batch.nbytes > options.max_batch_bytes:
            raise ValueError("Decoded Arrow batch byte bound exceeded")
        # Schema validation rejects duplicate struct fields before conversion.
        columns = [column.to_pylist() for column in batch.columns]
        rows = []
        for values in zip(*columns):
            text = json.dumps(values, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
            encoded = text.encode("utf-8")
            budget["rows"] += 1
            budget["decoded_bytes"] += len(encoded)
            if (len(encoded) > options.max_row_bytes or budget["rows"] > options.max_rows
                    or budget["decoded_bytes"] > options.max_decoded_bytes):
                raise ValueError("Decoded row, total row or byte bound exceeded")
            ordered_hash.update(encoded + b"\n")
            rows.append((count, text))
            count += 1
        connection.executemany(f"INSERT INTO {quoted(storage)} VALUES (?, ?)", rows)
    if count != parquet.metadata.num_rows:
        raise ValueError("Decoded row count differs from the Parquet footer")
    return count, ordered_hash.hexdigest()


def import_asset(connection, asset, options, budget, deadline, pq):
    path = Path(options.directory) / asset["name"]
    if path.is_symlink() or not path.is_file():
        raise ValueError("Each manifest asset must be a regular local file")
    table = "index" if asset["name"] == "idc_index.parquet" else asset["name"][:-8]
    with path.open("rb") as stream:
        before = fingerprint(stream)
        if before[2] != asset["size"] or file_hash(stream, deadline, asset["size"]) != asset["digest"][7:]:
            raise ValueError("Parquet file size or SHA-256 mismatch")
        parquet = pq.ParquetFile(stream, page_checksum_verification=True)
        schema = parquet.schema_arrow
        observed = validate_schema(schema, options.index_version)
        storage = create_table(connection, table, schema.names)
        rows, ordered_hash = import_rows(connection, parquet, storage, options, budget, deadline)
        if fingerprint(stream) != before or file_hash(stream, deadline, asset["size"]) != asset["digest"][7:] or fingerprint(stream) != before:
            raise ValueError("Source artifact changed during import")
    # Index exact native identity cells; duplicates remain separate rows.
    for keys in [("SeriesInstanceUID",), ("collection_id", "PatientID")]:
        if not all(key in schema.names for key in keys):
            continue
        expressions = [f"json_extract(native_json, '$[{schema.names.index(key)}]')" for key in keys]
        connection.execute(f"CREATE INDEX {quoted(storage + '_' + '_'.join(keys))} ON {quoted(storage)} ({', '.join(expressions)})")
    evidence = {"asset": asset, "table": table, "storage_table": storage, "columns": schema.names,
                "arrow_schema_base64": base64.b64encode(schema.serialize().to_pybytes()).decode("ascii"),
                "observed_index_metadata": observed, "rows": rows, "row_groups": parquet.metadata.num_row_groups,
                "ordered_rows_sha256": ordered_hash, "complete_file": True}
    connection.execute("INSERT INTO _idc_artifacts VALUES (?, ?)", (table, json.dumps(evidence, ensure_ascii=False)))
    connection.commit()
    return evidence


def import_index(options):
    import pyarrow
    import pyarrow.parquet as pq

    if pyarrow.__version__ == "19.0.0":
        raise ValueError("PyArrow 19.0.0 has the histogram reader bug (Arrow #45283); use a compatible reader")
    bounds = [options.max_source_bytes, options.max_decoded_bytes, options.max_rows,
              options.max_row_bytes, options.max_batch_bytes, options.deadline_seconds]
    if any(not math.isfinite(value) or value <= 0 for value in bounds):
        raise ValueError("Import bounds must be finite and positive")
    output = Path(options.output)
    if output.exists() or output.is_symlink():
        raise FileExistsError("Output already exists; choose a new SQLite filename")
    deadline = time.monotonic() + options.deadline_seconds
    raw, manifest_hash, assets = release_manifest(options)
    budget = {"rows": 0, "decoded_bytes": 0}
    with tempfile.TemporaryDirectory(prefix=".idc-import-", dir=output.parent) as directory:
        temporary = Path(directory) / "index.sqlite"
        connection = sqlite3.connect(temporary)
        try:
            connection.execute("PRAGMA cache_size=-32768")
            connection.set_progress_handler(lambda: int(time.monotonic() > deadline), 10000)
            connection.execute("CREATE TABLE _idc_artifacts (table_name TEXT PRIMARY KEY, evidence_json TEXT NOT NULL)")
            connection.execute("CREATE TABLE _idc_provenance (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)")
            connection.execute("INSERT INTO _idc_provenance VALUES ('release_manifest', ?)", (raw,))
            artifacts = [import_asset(connection, a, options, budget, deadline, pq) for a in assets]
            receipt = {"index_version": options.index_version, "idc_release": "v" + options.index_version.split(".")[0],
                       "manifest_sha256": manifest_hash, "manifest_basis": "Caller-pinned local native GitHub release JSON; no network authentication performed",
                       "reader": "pyarrow " + pyarrow.__version__, "artifacts": artifacts, **budget,
                       "source_bytes": sum(a["size"] for a in assets), "complete_parquet_asset_set": True,
                       "cell_encoding": "ordered JSON arrays; source column order, nulls, nested arrays/objects, booleans and finite numbers retained; non-JSON values rejected",
                       "row_hash_encoding": "SHA-256 of each UTF-8 native_json followed by LF, in zero-based file order",
                       "clinical_data_included": False, "dicom_data_included": False,
                       "imported_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
            connection.execute("INSERT INTO _idc_provenance VALUES ('import', ?)", (json.dumps(receipt, ensure_ascii=False),))
            connection.commit()
            if connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise ValueError("SQLite integrity check failed")
        finally:
            connection.close()
        check_deadline(deadline)
        # Atomic no-replacement publication, including a concurrently created output.
        os.link(temporary, output)
    return receipt


def parser():
    command = argparse.ArgumentParser(description=__doc__)
    command.add_argument("--release-manifest", required=True)
    command.add_argument("--expected-manifest-sha256", required=True)
    command.add_argument("--index-version", required=True)
    command.add_argument("--directory", required=True, help="Directory containing every released Parquet asset")
    command.add_argument("--output", required=True, help="New local SQLite file; never overwritten")
    command.add_argument("--max-source-bytes", type=int, default=1024**3)
    command.add_argument("--max-decoded-bytes", type=int, default=16 * 1024**3)
    command.add_argument("--max-rows", type=int, default=10_000_000)
    command.add_argument("--max-row-bytes", type=int, default=2 * 1024**2)
    command.add_argument("--max-batch-bytes", type=int, default=64 * 1024**2)
    command.add_argument("--deadline-seconds", type=float, default=1200)
    return command


if __name__ == "__main__":
    print(json.dumps(import_index(parser().parse_args()), ensure_ascii=False))
