"""The runtime image is Python 3.9; the dev machines are not.

`list | None` in an annotation is evaluated at def time on 3.9 and raises TypeError on IMPORT,
so a single such annotation anywhere in the import graph takes the whole executor down at boot
rather than failing the one function that uses it. That is exactly how it shipped once: a merge
took a `split_commitments: list | None = None` over the box's `Optional[list]`, every test passed
on 3.12, and the container crash-looped.

`from __future__ import annotations` makes annotations lazy strings and removes the hazard for a
whole module. This test asserts that every module carrying 3.10+ annotation syntax has it.
"""
import ast
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]

# Skip trees we do not ship or control.
SKIP_PARTS = {".venv", "venv", "__pycache__", ".pytest_cache", "tests", "node_modules"}


def _has_future_annotations(tree: ast.AST) -> bool:
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module == "__future__":
            if any(a.name == "annotations" for a in node.names):
                return True
    return False


def _uses_pep604(tree: ast.AST) -> bool:
    """True if any ANNOTATION uses `X | Y`. Only annotations matter: a `|` in a normal
    expression is just an operator and is fine on 3.9."""
    found = []

    def scan(node):
        for sub in ast.walk(node):
            if isinstance(sub, ast.BinOp) and isinstance(sub.op, ast.BitOr):
                found.append(sub)

    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for arg in list(node.args.args) + list(node.args.kwonlyargs) + list(node.args.posonlyargs):
                if arg.annotation is not None:
                    scan(arg.annotation)
            if node.returns is not None:
                scan(node.returns)
        elif isinstance(node, ast.AnnAssign) and node.annotation is not None:
            scan(node.annotation)
    return bool(found)


def test_pep604_annotations_only_where_future_import_is_present():
    offenders = []
    for path in sorted(ROOT.rglob("*.py")):
        if SKIP_PARTS & set(path.relative_to(ROOT).parts):
            continue
        try:
            tree = ast.parse(path.read_text(), filename=str(path))
        except SyntaxError:
            continue
        if _uses_pep604(tree) and not _has_future_annotations(tree):
            offenders.append(str(path.relative_to(ROOT)))

    assert not offenders, (
        "These modules use `X | Y` annotations but lack `from __future__ import annotations`. "
        "On the Python 3.9 runtime image they raise TypeError at import and take the executor "
        f"down at boot: {offenders}"
    )
