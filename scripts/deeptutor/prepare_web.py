"""Prepares DeepTutor's packaged web app for one runtime home and prints where its server is (decision #541).

Usage (DeepTutor's own interpreter): python prepare_web.py <runtime home> <web port> <API address>
The copy into `<home>/data/user/runtime/web` and the placeholder patching are DeepTutor's own code
(`deeptutor.runtime.launcher._resolve_frontend`, a private helper of 1.7.4); `deeptutor start` cannot be used because
it binds every interface. The last line of standard output is JSON: {"server": "<path of server.js>"}.
"""

import json
import os
import sys
from pathlib import Path

home, port, api_base = Path(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
os.environ["DEEPTUTOR_HOME"] = str(home)

from deeptutor.runtime import launcher  # noqa: E402

frontend = launcher._resolve_frontend(home, port, api_base=api_base, auth_enabled=False)
print(json.dumps({"server": frontend.command[-1]}))
