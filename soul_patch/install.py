#!/usr/bin/env python3   install.py
"""Build/install the SOUL charge integration package using local originals."""

from pathlib import Path
from datetime import datetime
import argparse
import hashlib
import json
import re
import shutil
import subprocess
import uuid

VERSION = "soul-charge-bridge-1"

PATCH = Path(__file__).resolve().parent
ROOT = PATCH.parent

NEW_FILES = [
    "js/soul_sim.js",
    "js/simulator.js",
    "js/soul_charge_tests.js",
    "js/soul_sim_ui.js",
]

GLUE_FILES = [
    "index.html",
    "train.html",
    "js/training_worker.js",
    "js/training_ui.js",
    "js/match_manager.js",
    "js/soul_agent.js",
]


def fail(message):
    raise SystemExit("INSTALLATION STOPPED: " + message)


def once(text, old, new, name):
    count = text.count(old)
    if count != 1:
        fail(
            f"{name}: expected one integration marker, found {count}.\n"
            "Your checkout differs from the reviewed version. "
            "No project files have been replaced."
        )
    return text.replace(old, new, 1)


def bust(text):
    return re.sub(
        r"\.js\?v=[A-Za-z0-9._-]+",
        ".js?v=" + VERSION,
        text,
    )


def append_scripts(text, names, label):
    alternatives = "|".join(re.escape(name) for name in names)

    pattern = (
        r"""<script\b[^>]*\bsrc=["']js/(?:"""
        + alternatives
        + r""")(?:\?[^"']*)?["'][^>]*>\s*</script>\s*"""
    )

    text = re.sub(pattern, "", text, flags=re.IGNORECASE)

    tags = "\n".join(
        f'  <script src="js/{name}?v={VERSION}"></script>'
        for name in names
    )

    return once(
        text,
        "</body>",
        tags + "\n</body>",
        label,
    )


def sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Install generated files after validation and backup.",
    )
    args = parser.parse_args()

    originals = {}
    updates = {}

    for name in GLUE_FILES:
        path = ROOT / name
        if not path.is_file():
            fail(f"Missing project file: {name}")
        originals[name] = path.read_text(encoding="utf-8")

    for name in NEW_FILES:
        path = PATCH / name
        if not path.is_file():
            fail(f"Missing package file: soul_patch/{name}")
        updates[name] = path.read_text(encoding="utf-8")

        existing = ROOT / name
        if existing.is_file():
            originals[name] = existing.read_text(encoding="utf-8")

    if VERSION not in updates["js/soul_sim.js"]:
        fail("The replacement soul_sim.js has the wrong runtime.")

    worker = originals["js/training_worker.js"]
    if VERSION in worker:
        fail("This runtime appears to be installed already.")

    live = originals["js/match_manager.js"]

    if (
        not re.search(r"SoulSim\.reactor\s*\(", live)
        or "gs.soulEnv = E.create" not in live
    ):
        fail(
            "match_manager.js is not the reactive SoulEnv version. "
            "Do not apply this package to the older preplanned manager."
        )

    # Add runtime verification inside the worker.
    worker = once(
        worker,
        "let busy = false;",
        (
            f'if (SoulSim.VERSION !== "{VERSION}") {{\n'
            '  throw new Error("Mixed SOUL controller runtime files.");\n'
            "}\n\n"
            "let busy = false;"
        ),
        "training_worker.js/runtime",
    )

    worker = once(
        worker,
        "let totalRounds = 0;",
        (
            "let totalRounds = 0;\n"
            "  const chargeStats = SoulSim.newChargeStats();"
        ),
        "training_worker.js/statistics",
    )

    worker = once(
        worker,
        "kind: job.kind,",
        (
            "kind: job.kind,\n"
            "      runtime: SoulSim.VERSION,\n"
            "      chargeStats,"
        ),
        "training_worker.js/report",
    )

    worker = once(
        worker,
        "version: VERSION,",
        (
            "version: VERSION,\n"
            "      runtime: SoulSim.VERSION,"
        ),
        "training_worker.js/checkpoint",
    )

    marker = 'if (event.type === "transition") {'
    worker = once(
        worker,
        marker,
        (
            'if (event.type === "round") {\n'
            "        SoulSim.addChargeStat(\n"
            "          chargeStats, event.commits[learnerSlot]\n"
            "        );\n"
            "      }\n\n"
            "      " + marker
        ),
        "training_worker.js/round-events",
    )
    updates["js/training_worker.js"] = bust(worker)

    # Show charging diagnostics in the existing training UI.
    ui = originals["js/training_ui.js"]
    marker = r'return lines.join("\n");'

    ui = once(
        ui,
        marker,
        r'''if (r.chargeStats) {
        const c = r.chargeStats;
        const average = c.commits ? c.totalCharge / c.commits : 0;
        lines.push(
          "Runtime: " + r.runtime,
          "Charge commits: " + c.commits +
          "; partial: " + c.partial +
          "; full: " + c.full +
          "; average: " + average.toFixed(1) + "%",
          "Timeouts: " + c.timeouts +
          "; voluntary idle: " + c.idles +
          "; forced faint: " + c.fainted,
          "Charge bins [0-9,10-19,...,90-99,100]: " +
          JSON.stringify(c.bins)
        );
      }
      return lines.join("\n");''',
        "training_ui.js/charge-report",
    )
    updates["js/training_ui.js"] = bust(ui)

    # Neural live play must use an actual active model.
    marker = 'const checkpoint = g.SoulAgent.snapshot("active");'
    live = once(
        live,
        marker,
        marker + f'''
        if (g.SoulSim.VERSION !== "{VERSION}") {{
          throw new Error("Mixed live SOUL runtime files.");
        }}
        if (!checkpoint) {{
          throw new Error(
            "No ACTIVE neural checkpoint. Import, evaluate and activate " +
            "a model before selecting Ichigo SOUL."
          );
        }}
        gs.soulWeightsID = g.SoulAgent.fingerprint(checkpoint);
''',
        "match_manager.js/active-model",
    )
    updates["js/match_manager.js"] = live

    # Old evaluations must not qualify a newly updated runtime.
    agent = originals["js/soul_agent.js"]
    agent = once(
        agent,
        "report &&",
        "report &&\n      report.runtime === g.SoulSim.VERSION &&",
        "soul_agent.js/evaluation-runtime",
    )
    updates["js/soul_agent.js"] = agent

    updates["index.html"] = bust(append_scripts(
        originals["index.html"],
        [
            "simulator.js",
            "soul_charge_tests.js",
            "soul_sim_ui.js",
        ],
        "index.html",
    ))

    # Search dependencies are needed for browser-side integration tests.
    updates["train.html"] = bust(append_scripts(
        originals["train.html"],
        [
            "rider_brains.js",
            "foresee_engine.js",
            "ai.js",
            "cpu_controller.js",
            "simulator.js",
            "soul_charge_tests.js",
        ],
        "train.html",
    ))

    # All marker validation has completed before any project replacement.
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    build = ROOT / (
        "soul_charge_build_" + stamp + "_" + uuid.uuid4().hex[:6]
    )
    generated = build / "updated"
    backup = build / "originals"

    for name, text in updates.items():
        destination = generated / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(text, encoding="utf-8")

    for name, text in originals.items():
        destination = backup / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(text, encoding="utf-8")

    manifest = {
        "runtime": VERSION,
        "files": {
            name: {
                "before": sha(originals[name]) if name in originals else None,
                "after": sha(text),
            }
            for name, text in updates.items()
        },
    }
    (build / "manifest.json").write_text(
        json.dumps(manifest, indent=2),
        encoding="utf-8",
    )

    # Optional syntax validation. This does not run browser tests.
    node = shutil.which("node")
    if node:
        for name in updates:
            if not name.endswith(".js"):
                continue
            result = subprocess.run(
                [node, "--check", str(generated / name)],
                capture_output=True,
                text=True,
            )
            if result.returncode:
                fail(
                    f"JavaScript syntax check failed for {name}:\n"
                    + result.stderr
                    + f"\nBuild retained at {build}"
                )
        print("JavaScript syntax checks passed.")
    else:
        print("Node not found: JavaScript syntax checks were not run.")

    if args.apply:
        for name in updates:
            destination = ROOT / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(generated / name, destination)
        print("Installed. Original files are backed up.")
    else:
        print("Preview only: project source files were not replaced.")
        print("Run again with --apply to install.")

    print("Build:", build)
    print("Complete updated files:", generated)
    print("Original files:", backup)
    print("No data files or trained weights were modified.")
    print("Browser integration tests have NOT been executed by this installer.")


if __name__ == "__main__":
    main()
