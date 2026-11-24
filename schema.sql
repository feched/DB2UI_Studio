-- Демонстрационная таблица для учебного приложения F:\DB2UI.
-- Выполнить в psql:
--   psql -U postgres -h localhost -d postgres -f "F:\DB2UI\schema.sql"
--
-- Таблицу можно заменить своей, но тогда в app.py нужно поменять
-- TABLE_NAME и SQL-запросы (поля full_name и age).

CREATE TABLE IF NOT EXISTS "students" (
    id         BIGSERIAL PRIMARY KEY,
    full_name  VARCHAR(120) NOT NULL CHECK (btrim(full_name) <> ''),
    age        SMALLINT     NOT NULL CHECK (age BETWEEN 0 AND 120),
    created_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Примеры записей. Повторный запуск файла не создаст дубликаты,
-- потому что вставляем только если таблица пустая.
INSERT INTO "students" (full_name, age)
SELECT *
FROM (
    VALUES
        ('Анна Смирнова', 20),
        ('Борис Иванов', 22),
        ('Виктория Петрова', 19),
        ('Глеб Соколов', 25),
        ('Дарья Козлова', 21)
) AS demo(full_name, age)
WHERE NOT EXISTS (SELECT 1 FROM "students");

-- Проверка результата:
SELECT * FROM "students" ORDER BY id;
