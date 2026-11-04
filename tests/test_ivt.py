"""IVT integration and AR scale ranking.

    PYTHONPATH=. python tests/test_ivt.py
"""
import numpy as np

from briefing import context, grib


def test_ivt_uniform_column():
    # q = 0.01 kg/kg and u = 20 m/s through 1000–300 hPa: IVT = q*u*dp/g = 0.01*20*70000/9.80665
    levs = [300, 500, 700, 850, 925, 1000]                      # any order
    shape = (len(levs), 2, 2)
    iu, iv = grib.ivt_from_levels(np.full(shape, 0.01), np.full(shape, 20.0), np.zeros(shape), levs)
    assert abs(iu[0, 0] - 0.01 * 20 * 70000 / 9.80665) < 1e-2 and iv[0, 0] == 0


def test_ar_scale_ranks():
    six = lambda vals: list(vals)                                  # 6-hourly samples
    # strong (750-1000) lasting 24-48 h -> AR3
    ev = context.ar_events([0, 6, 12, 18, 24, 30], six([300, 600, 820, 700, 400, 100]), step=6)
    assert len(ev) == 1 and ev[0]["rank"] == 3 and ev[0]["peak"] == 820 and ev[0]["hours"] == 30
    # moderate but >= 48 h -> promoted to AR3
    ev = context.ar_events(list(range(0, 61, 6)), [520] * 9 + [100, 100], step=6)
    assert ev[0]["rank"] == 3
    # weak and under 24 h -> AR0 (below the scale), still listed with its peak
    ev = context.ar_events([0, 6, 12], [260, 300, 100], step=6)
    assert ev[0]["rank"] == 0
    # two separate events
    ev = context.ar_events(list(range(0, 49, 6)), [300, 300, 300, 300, 100, 100, 1300, 1300, 1300], step=6)
    assert [e["rank"] for e in ev] == [1, 4]                         # exceptional but < 24 h -> AR4


if __name__ == "__main__":
    test_ivt_uniform_column()
    test_ar_scale_ranks()
    print("ok")
