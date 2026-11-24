"""Создаёт иконку приложения assets/db2ui.ico (запускается один раз при сборке)."""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "db2ui.ico"
SIZE = 256


def _font(size: int) -> ImageFont.FreeTypeFont:
    candidates = [
        Path(r"C:\Windows\Fonts\segoeuib.ttf"),
        Path(r"C:\Windows\Fonts\arialbd.ttf"),
    ]
    for path in candidates:
        if path.exists():
            return ImageFont.truetype(str(path), size)
    return ImageFont.load_default()


def main() -> None:
    image = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    # Скруглённый оранжевый квадрат — фирменный цвет DB2UI.
    radius = 54
    draw.rounded_rectangle((8, 8, SIZE - 8, SIZE - 8), radius=radius, fill=(242, 121, 26, 255))
    draw.rounded_rectangle(
        (8, 8, SIZE - 8, SIZE - 8),
        radius=radius,
        outline=(255, 255, 255, 38),
        width=4,
    )

    # Белая «таблица» с полосами.
    board = (58, 72, SIZE - 58, SIZE - 72)
    draw.rounded_rectangle(board, radius=18, fill=(255, 255, 255, 242))
    line_color = (242, 121, 26, 255)
    for index, y in enumerate((112, 142, 172)):
        draw.rounded_rectangle((78, y, SIZE - 78, y + 10), radius=5, fill=line_color)
    # Верхняя «шапка» таблицы.
    draw.rounded_rectangle((58, 72, SIZE - 58, 104), radius=18, fill=(255, 255, 255, 255))
    draw.rectangle((58, 90, SIZE - 58, 106), fill=(255, 255, 255, 255))

    small = _font(46)
    text = "DB"
    left, top, right, bottom = draw.textbbox((0, 0), text, font=small)
    draw.text(
        ((SIZE - (right - left)) / 2, SIZE - 46 - bottom),
        text,
        font=small,
        fill=(255, 255, 255, 255),
    )

    OUT.parent.mkdir(parents=True, exist_ok=True)
    image.save(OUT, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print(f"icon: {OUT}")


if __name__ == "__main__":
    main()
