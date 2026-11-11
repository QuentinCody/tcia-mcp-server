"""Offline import contracts, including real nested Parquet fixtures and failure cleanup."""

import hashlib
import importlib.util
import json
import math
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import pyarrow as pa
import pyarrow.parquet as pq


SOURCE = Path(__file__).resolve().parents[1] / "scripts" / "import_idc_index.py"
SPEC = importlib.util.spec_from_file_location("idc_import", SOURCE)
IMPORTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(IMPORTER)


class BulkImportTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.rows = [
            {"SeriesInstanceUID": "001.02", "collection_id": "study", "PatientID": "0001",
             "anatomy": ["Lung", "Lung", "β"], "present": True, "value": -0.0,
             "license": {"name": "CC BY 4.0", "links": [None, "https://example.org"]}},
            {"SeriesInstanceUID": "001.02", "collection_id": "study", "PatientID": "0001",
             "anatomy": [], "present": False, "value": None, "license": None},
        ]
        self.asset("idc_index", pa.Table.from_pylist(self.rows))
        self.asset("version_metadata_index", pa.table({"idc_version": [24], "version_timestamp": ["2026-01-01"]}))
        self.refresh_manifest()

    def asset(self, name, table):
        table = table.replace_schema_metadata({b"idc_index_data_version": b"24.2.2-0-gabc123"})
        pq.write_table(table, self.root / (name + ".parquet"), row_group_size=1)

    def refresh_manifest(self, mutate=None):
        assets = [{"name": p.name, "size": p.stat().st_size,
                   "digest": "sha256:" + hashlib.sha256(p.read_bytes()).hexdigest(),
                   "browser_download_url": f"{IMPORTER.RELEASES}/download/24.2.2/{p.name}"}
                  for p in sorted(self.root.glob("*.parquet"))]
        data = {"tag_name": "24.2.2", "html_url": f"{IMPORTER.RELEASES}/tag/24.2.2",
                "draft": False, "prerelease": False, "assets": assets}
        if mutate:
            mutate(data)
        raw = json.dumps(data).encode()
        manifest = self.root / "release.json"
        manifest.write_bytes(raw)
        self.options = IMPORTER.parser().parse_args([
            "--release-manifest", str(manifest), "--expected-manifest-sha256", hashlib.sha256(raw).hexdigest(),
            "--index-version", "24.2.2", "--directory", str(self.root), "--output", str(self.root / "index.sqlite")])

    def fails(self, match):
        with self.assertRaisesRegex((ValueError, OSError), match):
            IMPORTER.import_index(self.options)
        self.assertFalse(Path(self.options.output).exists())
        self.assertEqual(list(self.root.glob(".idc-import-*")), [])

    def test_complete_nested_rows_and_sql_join_preserve_identity(self):
        receipt = IMPORTER.import_index(self.options)
        self.assertEqual(receipt["rows"], 3)
        self.assertTrue(receipt["complete_parquet_asset_set"])
        with sqlite3.connect(self.options.output) as db:
            artifact = json.loads(db.execute("SELECT evidence_json FROM _idc_artifacts WHERE table_name='index'").fetchone()[0])
            encoded = db.execute("SELECT row_index,native_json FROM _idc_rows_index ORDER BY row_index").fetchall()
            self.assertEqual([index for index, _ in encoded], [0, 1])
            recovered = [dict(zip(artifact["columns"], json.loads(row))) for _, row in encoded]
            self.assertEqual(recovered, self.rows)
            self.assertEqual(math.copysign(1, recovered[0]["value"]), -1)
            self.assertEqual(hashlib.sha256(b"".join((row + "\n").encode() for _, row in encoded)).hexdigest(), artifact["ordered_rows_sha256"])
            self.assertEqual(db.execute('SELECT PatientID, present FROM "index" ORDER BY present').fetchall(), [("0001", 0), ("0001", 1)])
            self.assertEqual(db.execute('SELECT COUNT(*) FROM "index" WHERE SeriesInstanceUID=?', ("001.02",)).fetchone()[0], 2)
            self.assertEqual(db.execute("PRAGMA quick_check").fetchone()[0], "ok")

    def test_pinned_manifest_and_stable_release_required(self):
        self.options.expected_manifest_sha256 = "0" * 64
        self.fails("manifest SHA-256")
        for field, value in [("tag_name", "24.2.3"), ("draft", True), ("prerelease", True), ("html_url", "https://example.org")]:
            with self.subTest(field=field):
                self.refresh_manifest(lambda d: d.update({field: value}))
                self.fails("stable official")

    def test_missing_corrupt_and_wrong_sized_assets_publish_nothing(self):
        path = self.root / "version_metadata_index.parquet"
        raw = path.read_bytes()
        path.unlink()
        self.fails("regular local file")
        path.write_bytes(raw[:-1])
        self.fails("size or SHA-256")
        path.write_bytes(raw[:-1] + b"X")
        self.fails("size or SHA-256")

    def test_bad_asset_identity_checksum_duplicates_and_collision(self):
        mutations = [lambda a: a.update(name="../bad.parquet"),
                     lambda a: a.update(browser_download_url="https://example.org/a.parquet"),
                     lambda a: a.update(digest=None), lambda a: a.update(size=True)]
        for mutation in mutations:
            self.refresh_manifest(lambda d: mutation(d["assets"][0]))
            self.fails("Invalid Parquet")
        self.refresh_manifest(lambda d: d["assets"].append(d["assets"][0]))
        self.fails("Duplicate release")
        self.asset("index", pa.table({"value": [1]}))
        self.refresh_manifest()
        self.fails("collide")

    def test_wrong_native_version_and_missing_metadata_fail(self):
        path = self.root / "version_metadata_index.parquet"
        for metadata in [{b"idc_index_data_version": b"24.2.1-0-gabc"}, None]:
            pq.write_table(pa.table({"idc_version": [24]}).replace_schema_metadata(metadata), path)
            self.refresh_manifest()
            self.fails("metadata does not match")

    def test_unsupported_types_nested_duplicates_and_nonfinite_fail(self):
        samples = [pa.table({"binary": [b"bytes"]}), pa.table({"value": [float("nan")]}),
                   pa.table({"value": [float("inf")]}), pa.Table.from_arrays([pa.array([1]), pa.array([2])], names=["ID", "id"])]
        for sample in samples:
            self.asset("idc_index", sample)
            self.refresh_manifest()
            self.fails("Unsupported|Out of range")
        nested = pa.struct([("same", pa.int32()), ("same", pa.int32())])
        schema = pa.schema([("value", nested)], metadata={b"idc_index_data_version": b"24.2.2"})
        with self.assertRaisesRegex(ValueError, "duplicate nested"):
            IMPORTER.validate_schema(schema, "24.2.2")

    def test_bounds_and_expired_deadline_publish_nothing(self):
        for field in ["max_source_bytes", "max_decoded_bytes", "max_rows", "max_row_bytes", "max_batch_bytes"]:
            self.refresh_manifest()
            setattr(self.options, field, 1)
            self.fails("bound")
        self.refresh_manifest()
        self.options.deadline_seconds = 0.000001
        self.fails("deadline")
        for value in [0, -1, float("nan"), float("inf")]:
            self.options.deadline_seconds = value
            self.fails("finite and positive")

    def test_existing_output_and_symlink_preserved(self):
        output = Path(self.options.output)
        output.write_bytes(b"existing database")
        with self.assertRaises(FileExistsError):
            IMPORTER.import_index(self.options)
        self.assertEqual(output.read_bytes(), b"existing database")
        output.unlink()
        output.symlink_to(self.root / "not-created")
        with self.assertRaises(FileExistsError):
            IMPORTER.import_index(self.options)
        self.assertTrue(output.is_symlink())

    def test_concurrent_output_creation_is_not_overwritten(self):
        original = IMPORTER.os.link

        def competing_publication(source, target):
            Path(target).write_bytes(b"another import")
            original(source, target)

        with patch.object(IMPORTER.os, "link", side_effect=competing_publication):
            with self.assertRaises(FileExistsError):
                IMPORTER.import_index(self.options)
        self.assertEqual(Path(self.options.output).read_bytes(), b"another import")
        self.assertEqual(list(self.root.glob(".idc-import-*")), [])

    def test_source_mutation_after_decode_rejected(self):
        original = IMPORTER.import_rows

        def mutate_after_decode(*args):
            result = original(*args)
            path = self.root / "idc_index.parquet"
            raw = path.read_bytes()
            path.write_bytes(raw[:-1] + b"X")
            return result

        with patch.object(IMPORTER, "import_rows", side_effect=mutate_after_decode):
            self.fails("changed during import")

    def test_old_reader_fails_before_creating_output(self):
        with patch.object(pa, "__version__", "19.0.0"):
            self.fails("histogram reader bug")


if __name__ == "__main__":
    unittest.main()
