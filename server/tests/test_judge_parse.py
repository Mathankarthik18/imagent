from imagent_server import judge


def test_parse_unescaped_quotes_in_reason():
    text = ('{"better": "X", "reason": "Answer Y adds an unexplained `{"email_type": "general"}` artifact.", '
            '"scores": {"X": {"correct": 5, "complete": 4, "clear": 5}, "Y": {"correct": 2, "complete": 3, "clear": 3}}}')
    d = judge._parse(text)
    assert d["better"] == "X"
    assert d["reason"].startswith("Answer Y adds") and '"email_type"' in d["reason"]
    assert d["scores"]["Y"]["correct"] == 2


def test_parse_valid_json_unchanged():
    d = judge._parse('noise {"better": "tie", "reason": "same", "scores": {"X": {}, "Y": {}}}')
    assert d == {"better": "tie", "reason": "same", "scores": {"X": {}, "Y": {}}}
