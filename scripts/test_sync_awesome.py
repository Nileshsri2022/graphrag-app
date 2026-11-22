"""Unit tests for the item-metadata cache in sync_awesome.py.

Covers the cache helpers (freshness, load/save) and the resolve path
(cache hit / miss / stale / rate-limited) with the GraphQL layer
mocked -- no network, no token, no live GitHub needed.

Run from scripts/:
  python3 -m unittest test_sync_awesome -v
"""

import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import sync_awesome  # noqa: E402


def _ts(days_ago=0):
    """A fetchedAt timestamp N days ago, in the cache's format."""
    return (datetime.now(timezone.utc) - timedelta(days=days_ago)).strftime(
        "%Y-%m-%dT%H:%M:%SZ")


def _entry(stars=100, archived=False, days_ago=0, **extra):
    e = {"stars": stars, "archived": archived,
         "pushedAt": "2026-11-20", "updatedAt": "2026-11-20",
         "fetchedAt": _ts(days_ago)}
    e.update(extra)
    return e


class TestItemCacheFresh(unittest.TestCase):
    def test_fresh_entry(self):
        self.assertTrue(sync_awesome.item_cache_fresh(_entry(days_ago=0)))
        self.assertTrue(sync_awesome.item_cache_fresh(_entry(days_ago=6)))

    def test_stale_entry(self):
        self.assertFalse(sync_awesome.item_cache_fresh(_entry(days_ago=7)))
        self.assertFalse(sync_awesome.item_cache_fresh(_entry(days_ago=30)))

    def test_falsy_values_still_fresh(self):
        # stars=0 and archived=False are legitimate values; the check
        # must use key presence, not truthiness.
        self.assertTrue(sync_awesome.item_cache_fresh(
            _entry(stars=0, archived=False, days_ago=1)))
        self.assertTrue(sync_awesome.item_cache_fresh(
            _entry(stars=0, archived=True, days_ago=1)))

    def test_missing_required_fields(self):
        self.assertFalse(sync_awesome.item_cache_fresh(
            {"archived": False, "fetchedAt": _ts(0)}))  # no stars
        self.assertFalse(sync_awesome.item_cache_fresh(
            {"stars": 5, "fetchedAt": _ts(0)}))  # no archived
        self.assertFalse(sync_awesome.item_cache_fresh(
            {"stars": 5, "archived": False}))  # no fetchedAt

    def test_corrupt_fetched_at(self):
        self.assertFalse(sync_awesome.item_cache_fresh(
            _entry(fetchedAt="not-a-date")))
        self.assertFalse(sync_awesome.item_cache_fresh(
            _entry(fetchedAt="")))

    def test_non_dict(self):
        self.assertFalse(sync_awesome.item_cache_fresh(None))
        self.assertFalse(sync_awesome.item_cache_fresh("x"))
        self.assertFalse(sync_awesome.item_cache_fresh([]))


class TestLoadSaveItemCache(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / ".item_cache.json"
        self._patch = mock.patch.object(sync_awesome, "ITEM_CACHE_PATH",
                                        self.path)
        self._patch.start()

    def tearDown(self):
        self._patch.stop()
        self.tmp.cleanup()

    def test_missing_file_is_empty(self):
        self.assertEqual(sync_awesome.load_item_cache(), {})

    def test_corrupt_file_is_empty_no_crash(self):
        self.path.write_text("{not valid json", encoding="utf-8")
        self.assertEqual(sync_awesome.load_item_cache(), {})

    def test_non_dict_json_is_empty(self):
        self.path.write_text('["a", "b"]', encoding="utf-8")
        self.assertEqual(sync_awesome.load_item_cache(), {})

    def test_roundtrip(self):
        cache = {"a/b": _entry(stars=42), "c/d": _entry(stars=7)}
        sync_awesome.save_item_cache(cache)
        self.assertEqual(sync_awesome.load_item_cache(), cache)


class TestResolveItemMeta(unittest.TestCase):
    def setUp(self):
        self.cache = {}

    def _fake_meta(self, names):
        return {fn: {"stars": 10, "archived": False,
                     "pushedAt": "2026-11-21",
                     "updatedAt": "2026-11-21"} for fn in names}

    def test_cache_hit_no_graphql_call(self):
        self.cache = {"a/b": _entry(stars=100), "c/d": _entry(stars=200)}
        with mock.patch.object(sync_awesome, "graphql_item_meta") as g:
            meta, resolved = sync_awesome.resolve_item_meta(
                ["a/b", "c/d"], self.cache)
            g.assert_not_called()
        self.assertEqual(resolved, 0)
        self.assertEqual(meta["a/b"]["stars"], 100)
        self.assertEqual(meta["c/d"]["stars"], 200)
        # fetchedAt is stripped from the returned meta (not a rating field)
        self.assertNotIn("fetchedAt", meta["a/b"])

    def test_cache_miss_resolves_and_updates_cache(self):
        with mock.patch.object(
                sync_awesome, "graphql_item_meta",
                side_effect=self._fake_meta) as g:
            meta, resolved = sync_awesome.resolve_item_meta(
                ["a/b", "c/d"], self.cache)
            g.assert_called_once()
            called_with = g.call_args[0][0]
            self.assertEqual(sorted(called_with), ["a/b", "c/d"])
        self.assertEqual(resolved, 2)
        self.assertEqual(meta["a/b"]["stars"], 10)
        # cache now holds the resolved entries with a fresh fetchedAt
        self.assertIn("fetchedAt", self.cache["a/b"])
        self.assertEqual(self.cache["a/b"]["stars"], 10)
        self.assertTrue(sync_awesome.item_cache_fresh(self.cache["a/b"]))

    def test_stale_entry_re_resolved(self):
        self.cache = {"a/b": _entry(stars=1, days_ago=30)}
        with mock.patch.object(
                sync_awesome, "graphql_item_meta",
                side_effect=self._fake_meta) as g:
            meta, resolved = sync_awesome.resolve_item_meta(
                ["a/b"], self.cache)
            g.assert_called_once_with(["a/b"])
        self.assertEqual(resolved, 1)
        self.assertEqual(meta["a/b"]["stars"], 10)  # new value wins
        self.assertTrue(sync_awesome.item_cache_fresh(self.cache["a/b"]))

    def test_mixed_fresh_stale_missing(self):
        self.cache = {
            "fresh/x": _entry(stars=111),
            "stale/y": _entry(stars=222, days_ago=30),
        }
        with mock.patch.object(
                sync_awesome, "graphql_item_meta",
                side_effect=self._fake_meta) as g:
            meta, resolved = sync_awesome.resolve_item_meta(
                ["fresh/x", "stale/y", "new/z"], self.cache)
            called_with = sorted(g.call_args[0][0])
            # only the stale + missing names go to GraphQL
            self.assertEqual(called_with, ["new/z", "stale/y"])
        self.assertEqual(resolved, 2)
        self.assertEqual(meta["fresh/x"]["stars"], 111)  # from cache
        self.assertEqual(meta["stale/y"]["stars"], 10)   # re-resolved
        self.assertEqual(meta["new/z"]["stars"], 10)     # resolved

    def test_duplicate_names_deduped(self):
        with mock.patch.object(
                sync_awesome, "graphql_item_meta",
                side_effect=self._fake_meta) as g:
            meta, resolved = sync_awesome.resolve_item_meta(
                ["a/b", "a/b", "c/d"], self.cache)
            self.assertEqual(sorted(g.call_args[0][0]), ["a/b", "c/d"])
        self.assertEqual(resolved, 2)

    def test_rate_limited_keeps_cached_entries(self):
        self.cache = {"a/b": _entry(stars=100)}
        with mock.patch.object(
                sync_awesome, "graphql_item_meta",
                side_effect=sync_awesome.RateLimited("429")):
            meta, resolved = sync_awesome.resolve_item_meta(
                ["a/b", "c/d"], self.cache)
        # the fresh cached entry survives; the uncached one inherits
        # parent signals downstream (it is simply absent here)
        self.assertEqual(resolved, 0)
        self.assertEqual(meta, {"a/b": {"stars": 100, "archived": False,
                                        "pushedAt": "2026-11-20",
                                        "updatedAt": "2026-11-20"}})
        self.assertNotIn("c/d", meta)


if __name__ == "__main__":
    unittest.main()
