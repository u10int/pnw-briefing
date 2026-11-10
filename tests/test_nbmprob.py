from briefing import nbmprob

IDX = """1:0:d=2026110912:APCP:surface:0-1 day acc fcst:prob >25.4:prob fcst 255/255
2:100:d=2026110912:APCP:surface:0-1 day acc fcst:prob >50.8:prob fcst 255/255
3:250:d=2026110912:GUST:10 m above ground:24 hour fcst:prob >21.0922:prob fcst 255/255
4:400:d=2026110912:APCP:surface:18-24 hour acc fcst:prob >25.4:prob fcst 255/255
"""


def test_period_text():
    assert nbmprob.period(0, 24) == "0-1 day acc fcst"
    assert nbmprob.period(6, 30) == "6-30 hour acc fcst"
    assert nbmprob.period(24, 96) == "1-4 day acc fcst"


def test_find_rows_and_ranges():
    rows = nbmprob.parse_idx(IDX)
    r = nbmprob._find(rows, "APCP", "0-1 day acc fcst", 50.8)
    assert r[0] == 100 and r[1] == 249
    g = nbmprob._find(rows, "GUST", "24 hour fcst", nbmprob.GUST_MS[47], "10 m above ground")
    assert g[0] == 250
    assert nbmprob._find(rows, "APCP", "0-1 day acc fcst", 76.2) is None
    assert rows[-1][1] is None
