"""Displayed claim values must not lose sub-unit prices: x402 per-call prices are often fractions of a cent, and a
rounded 0.001 once rendered as "0 USDC per call" (reported on issue #207). JSON and Markdown keep the raw value; the
HTML value must agree with it."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'atlas' / 'site'))
import build  # noqa: E402


class FmtValue(unittest.TestCase):
    def test_sub_cent_prices_keep_their_digits(self):
        for v, want in [(0.001, '0.001'), (0.002, '0.002'), (0.005, '0.005'), (0.0065, '0.0065'),
                        (0.0075, '0.0075'), (0.054, '0.054'), (0.00001, '0.00001')]:
            self.assertEqual(build.fmt_value(v), want, v)

    def test_never_renders_a_positive_value_as_zero(self):
        for v in (0.001, 0.0004, 0.00009, 1e-08):
            self.assertNotIn(build.fmt_value(v).strip('0.'), ('',), v)

    def test_larger_values_unchanged(self):
        for v, want in [(1405.05, '1,405.05'), (633.9, '633.9'), (12.0, '12'), (1.5, '1.5'), (3440, '3,440'), (0.5, '0.5')]:
            self.assertEqual(build.fmt_value(v), want, v)


if __name__ == '__main__':
    unittest.main()
