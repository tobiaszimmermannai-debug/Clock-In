import uvicorn

from .config import CFG


def main() -> None:
    uvicorn.run("clipper.main:app", host=CFG["server"]["host"], port=int(CFG["server"]["port"]), log_level="info")


if __name__ == "__main__":
    main()
