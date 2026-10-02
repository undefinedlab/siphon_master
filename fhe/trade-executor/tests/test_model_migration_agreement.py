"""Every ALTER TABLE ... ADD COLUMN in app.py must name a column its model actually declares.

The live database is migrated by raw ALTER statements in app.py, while queries go through the
SQLAlchemy models. Nothing ties the two together, so a column can be declared on the wrong model
and still look right in review: `prove_attempts` was added to `strategy_legs` by the migration but
declared on `Strategy`, whose table never gained it. The executor kept answering /health while
every scheduler query died with "no such column: strategy.prove_attempts".

This checks both directions for the migrated columns:
  - the migration's table has a model, and that model declares the column;
  - no OTHER model declares the same column name against a different table.
"""
import ast
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[1]

ALTER_RE = re.compile(
    r"ALTER\s+TABLE\s+([A-Za-z_][A-Za-z_0-9]*)\s+ADD\s+COLUMN\s+([A-Za-z_][A-Za-z_0-9]*)",
    re.IGNORECASE,
)


def _models():
    """{tablename: (ClassName, {column names})} parsed from database.py, no import needed."""
    tree = ast.parse((ROOT / "database.py").read_text())
    out = {}
    for node in tree.body:
        if not isinstance(node, ast.ClassDef):
            continue
        table, cols = None, set()
        for stmt in node.body:
            if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1:
                target = stmt.targets[0]
                if not isinstance(target, ast.Name):
                    continue
                if target.id == "__tablename__" and isinstance(stmt.value, ast.Constant):
                    table = stmt.value.value
                elif isinstance(stmt.value, ast.Call):
                    fn = stmt.value.func
                    # db.Column(...)
                    if isinstance(fn, ast.Attribute) and fn.attr == "Column":
                        cols.add(target.id)
        if table:
            out[table] = (node.name, cols)
    return out


def test_every_migrated_column_is_declared_on_its_own_model():
    models = _models()
    app_src = (ROOT / "app.py").read_text()

    problems = []
    for table, column in ALTER_RE.findall(app_src):
        if table not in models:
            # Tables with no ORM model are managed by raw SQL only; nothing to cross-check.
            continue
        model_name, cols = models[table]
        if column not in cols:
            elsewhere = [m for t, (m, c) in models.items() if column in c and t != table]
            hint = f" (it is declared on {elsewhere} instead)" if elsewhere else ""
            problems.append(
                f"{table}.{column} is added by an app.py migration but {model_name} does not "
                f"declare it{hint}"
            )

    assert not problems, "model/migration disagreement:\n  " + "\n  ".join(problems)
