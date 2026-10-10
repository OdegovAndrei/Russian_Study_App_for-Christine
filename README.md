# Russian Study

Простое приложение для изучения русского с французского: карточки с интервальным повторением, словарь и озвучка. Ничего лишнего — без уроков, уровней и аудирования.

- **Révision** — карточки FR → RU (в настройках можно RU → FR или оба направления). Кнопки: *À revoir / Difficile / Bien / Facile*, клавиши `Пробел`, `1–4`, `R` (повтор озвучки).
- **Vocabulaire** — весь словарь (735 слов и фраз), поиск, фильтры, озвучка каждой записи, добавление своих слов.
- **Réglages** — направление, новых карточек в день, голос (Svetlana / Dmitry), скорость, автозвук, сброс прогресса.

## Запуск

macOS: двойной клик по `Russian Study.command`.
Либо вручную:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python server.py        # http://localhost:5174
```

Прогресс хранится в `user-data/russian-study.json` (не в git). Озвучка — нейросетевой голос Microsoft Edge (`edge-tts`, нужен интернет при первом прослушивании слова; дальше берётся из `.tts-cache`). Без интернета используется голос браузера.

## Тесты

```bash
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p "test_*.py"
```
