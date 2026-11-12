import json
from pathlib import Path

DATA_DIR = Path(r'/home/eric/UltimateMCAgent/data')
def write_json_to_file(path: str | Path,data) -> None:
    with open(DATA_DIR / path,mode="w",encoding="utf-8") as f:
        f.write(json.dumps(data,indent=4,ensure_ascii=False))

def load_json_from_file(path: str | Path):
    with open(DATA_DIR / path,mode="r",encoding="utf-8") as f:
        text = f.read()
        data = json.loads(text)
        return data

def get_all_json_paths(dir_path: str | Path):
    result = []
    for path in (DATA_DIR / dir_path).iterdir():
        if path.is_file() and path.suffix == ".json":
            result.append(Path(dir_path) / path.name)
    return result

def get_text_from_file(path: str | Path):
    with open(DATA_DIR / path,mode="r",encoding="utf-8") as f:
        text = f.read()
        return text

def write_text_to_file(path: str | Path,text: str) -> None:
    with open(DATA_DIR / path,mode="w",encoding="utf-8") as f:
        f.write(text)