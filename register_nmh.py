"""Register (or unregister) the ext_bridge native messaging host.

Edge reads HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts
Chrome reads HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts

Usage:
  python register_nmh.py --init <EXTENSION_ID>   # write ext_bridge.json first
  python register_nmh.py            # register for Edge + Chrome
  python register_nmh.py --status   # show current registration
  python register_nmh.py --remove   # delete the keys

The extension ID appears on edge://extensions (or chrome://extensions) under
the loaded "OpenCode Browser Bridge" card. --init writes the NM manifest that
locks host launching to THAT extension id only.
"""
import json
import os
import sys
import winreg

DIR = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(DIR, "ext_bridge.json")
NAME = "ext_bridge"

ROOTS = (
    ("HKCU", winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Edge\NativeMessagingHosts"),
    ("HKCU", winreg.HKEY_CURRENT_USER, r"Software\Google\Chrome\NativeMessagingHosts"),
)


def init_manifest(ext_id):
    if not ext_id or len(ext_id) < 20:
        raise SystemExit("--init needs the extension id from edge://extensions "
                         "(32 lowercase letters, e.g.abcdefgh...)")
    doc = {
        "name": NAME,
        "description": "Native messaging host for the OpenCode Browser Bridge",
        "path": os.path.join(DIR, "native-host.bat"),
        "type": "stdio",
        "allowed_origins": ["chrome-extension://%s/" % ext_id],
    }
    with open(MANIFEST, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2)
    print("wrote %s (allowed_origins: %s)" % (MANIFEST, doc["allowed_origins"][0]))


def ensure_key(root, sub):
    winreg.CreateKeyEx(root, sub, 0, winreg.KEY_SET_VALUE)


def register():
    if not os.path.exists(MANIFEST):
        raise SystemExit(
            "manifest missing: " + MANIFEST +
            "\nRun first:  python register_nmh.py --init <EXTENSION_ID>"
            "\n(see edge://extensions for the id)")
    for label, root, sub in ROOTS:
        try:
            with winreg.CreateKeyEx(root, sub + "\\" + NAME, 0, winreg.KEY_SET_VALUE) as k:
                winreg.SetValueEx(k, "", 0, winreg.REG_SZ, MANIFEST)
            print(f"{label} {sub}\\{NAME} -> {MANIFEST}")
        except Exception as e:
            print(f"{label} {sub}: FAILED {e}")


def remove():
    for label, root, sub in ROOTS:
        try:
            winreg.DeleteKeyEx(root, sub + "\\" + NAME, winreg.KEY_SET_VALUE)
            print(f"removed {label} ...\\{NAME}")
        except FileNotFoundError:
            print(f"not registered: {label} ...\\{NAME}")
        except Exception as e:
            print(f"{label}: FAILED {e}")


def status():
    for label, root, sub in ROOTS:
        try:
            with winreg.OpenKey(root, sub + "\\" + NAME) as k:
                print(f"{label} {sub}\\{NAME} = {winreg.QueryValueEx(k, '')[0]}")
        except FileNotFoundError:
            print(f"{label} {sub}\\{NAME} : NOT REGISTERED")
        except Exception as e:
            print(f"{label} {sub} : {e}")


if __name__ == "__main__":
    arg = sys.argv[1] if len(sys.argv) > 1 else ""
    if arg == "--remove":
        remove()
    elif arg == "--status":
        status()
    elif arg == "--init":
        init_manifest(sys.argv[2] if len(sys.argv) > 2 else "")
        status()
    else:
        register()
        status()
