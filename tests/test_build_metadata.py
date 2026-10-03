"""Windows build metadata stays coupled to the package's release version."""

import ast
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "tools" / "build_windows.py"
SPEC = importlib.util.spec_from_file_location("frameweave_build_windows", SCRIPT)
BUILD = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
SPEC.loader.exec_module(BUILD)


def _call_with_name(tree, function_name):
    return next(
        node for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == function_name
    )


class BuildMetadataTests(unittest.TestCase):
    def test_version_resource_matches_package_version_and_chinese_brand(self):
        version = BUILD.read_project_version(ROOT / "frameweave" / "__init__.py")
        tree = ast.parse(BUILD.make_version_resource(version))
        resource = _call_with_name(tree, "VSVersionInfo")
        fields = {
            ast.literal_eval(call.args[0]): ast.literal_eval(call.args[1])
            for call in ast.walk(resource)
            if isinstance(call, ast.Call)
            and isinstance(call.func, ast.Name)
            and call.func.id == "StringStruct"
        }
        fixed = next(
            call for call in ast.walk(resource)
            if isinstance(call, ast.Call)
            and isinstance(call.func, ast.Name)
            and call.func.id == "FixedFileInfo"
        )
        fixed_fields = {keyword.arg: ast.literal_eval(keyword.value) for keyword in fixed.keywords}
        expected_tuple = BUILD.windows_version_tuple(version)

        self.assertEqual(fields["FileVersion"], version)
        self.assertEqual(fields["ProductVersion"], version)
        self.assertEqual(fixed_fields["filevers"], expected_tuple)
        self.assertEqual(fixed_fields["prodvers"], expected_tuple)
        self.assertEqual(fields["ProductName"], "棱光 PrismCanvas")
        self.assertIn("棱光 PrismCanvas", fields["FileDescription"])
        self.assertEqual(fields["OriginalFilename"], "PrismCanvas.exe")
        translation = _call_with_name(tree, "VarStruct")
        self.assertEqual(ast.literal_eval(translation.args[1]), [2052, 1200])

    def test_windows_version_components_are_bounded_and_padded(self):
        self.assertEqual(BUILD.windows_version_tuple("1.2.3"), (1, 2, 3, 0))
        for invalid in ("1.2.3rc1", "1.2.3.4.5", "1.65536.0"):
            with self.subTest(version=invalid), self.assertRaises(ValueError):
                BUILD.windows_version_tuple(invalid)

    def test_main_passes_metadata_and_explicit_dirs_to_pinned_pyinstaller(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output_dir = root / "candidate output"
            build_dir = root / "candidate work"
            calls = []
            version_contents = []
            transient_build_dirs = []

            def fake_run(command, **kwargs):
                calls.append((command, kwargs))
                if command[-1] == "--version":
                    return subprocess.CompletedProcess(command, 0, stdout=BUILD.PYINSTALLER_VERSION + "\n")
                resource_path = Path(command[command.index("--version-file") + 1])
                self.assertTrue(resource_path.is_file())
                version_contents.append(resource_path.read_text(encoding="utf-8"))
                spec_dir = Path(command[command.index("--specpath") + 1])
                work_dir = Path(command[command.index("--workpath") + 1])
                self.assertTrue(spec_dir.is_dir())
                self.assertEqual(work_dir, spec_dir / "work")
                self.assertTrue(spec_dir.is_relative_to(build_dir))
                transient_build_dirs.append(spec_dir)
                return subprocess.CompletedProcess(command, 0)

            with patch.object(BUILD.subprocess, "run", side_effect=fake_run):
                result = BUILD.main([
                    "--output-dir", str(output_dir),
                    "--build-dir", str(build_dir),
                ])

            self.assertEqual(result, 0)
            self.assertEqual(len(calls), 2)
            version_check, build_call = calls
            self.assertEqual(version_check[0], [sys.executable, "-m", "PyInstaller", "--version"])
            command, options = build_call
            self.assertEqual(command[:3], [sys.executable, "-m", "PyInstaller"])
            self.assertTrue(options["check"])
            for flag in ("--noconfirm", "--clean", "--onefile", "--windowed"):
                self.assertIn(flag, command)
            self.assertEqual(command[command.index("--name") + 1], "PrismCanvas")
            self.assertEqual(command[command.index("--distpath") + 1], str(output_dir.resolve()))
            self.assertEqual(
                command[command.index("--icon") + 1],
                str(ROOT / "assets" / "frameweave.ico"),
            )
            self.assertEqual(
                command[command.index("--add-data") + 1],
                f"{ROOT / 'web'};web",
            )
            self.assertEqual(command[-1], str(ROOT / "launch.py"))
            self.assertEqual(len(version_contents), 1)
            self.assertEqual(
                version_contents[0],
                BUILD.make_version_resource(BUILD.read_project_version()),
            )
            self.assertEqual(len(transient_build_dirs), 1)
            self.assertFalse(transient_build_dirs[0].exists())
            self.assertTrue(output_dir.is_dir())
            self.assertTrue(build_dir.is_dir())

    def test_existing_executable_is_preserved(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output_dir = root / "dist"
            output_dir.mkdir()
            executable = output_dir / "PrismCanvas.exe"
            executable.write_bytes(b"existing candidate")
            build_dir = root / "build"

            with patch.object(BUILD.subprocess, "run") as run:
                with self.assertRaises(SystemExit) as error:
                    BUILD.main(["--output-dir", str(output_dir), "--build-dir", str(build_dir)])

            self.assertEqual(error.exception.code, 2)
            self.assertEqual(executable.read_bytes(), b"existing candidate")
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
