from datetime import date

from briefing import convective

CSV = """Time,F_Scale,Location,County,State,Lat,Lon,Comments
Time,Speed,Location,County,State,Lat,Lon,Comments
1423,UNK,5 W FORKS,CLALLAM,WA,47.95,-124.48,Tree down on Highway 101. (SEW)
0130,62,AGATE BEACH,LINCOLN,OR,44.66,-124.06,Measured gust. (PQR)
Time,Size,Location,County,State,Lat,Lon,Comments
2210,75,2 N ABERDEEN,GRAYS HARBOR,WA,47.0,-123.8,Dime size hail. (SEW)
"""


def test_report_sections_and_times():
    rows = convective._parse_reports(CSV, date(2026, 11, 7))
    assert [r["type"] for r in rows] == ["wind", "wind", "hail"]
    assert rows[0]["time"].startswith("2026-11-07T14:23") and rows[0]["mag"] == "UNK" and rows[0]["location"] == "5 W Forks"
    assert rows[1]["time"].startswith("2026-11-08T01:30")          # before 12Z belongs to the next calendar day
    assert rows[2]["mag"] == "75" and rows[2]["lat"] == 47.0
