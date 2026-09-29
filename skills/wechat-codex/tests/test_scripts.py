import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]


class HelpersTest(unittest.TestCase):
    def run_script(self, name, target):
        return subprocess.run([sys.executable, str(SKILL / 'scripts' / name), '--target', str(target)], capture_output=True, text=True)

    def test_setup_and_refuse_overwrite(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / 'bridge with spaces'
            self.assertEqual(self.run_script('setup.py', target).returncode, 0)
            self.assertTrue((target / 'package-lock.json').exists())
            self.assertTrue((target / 'message-gate.mjs').exists())
            (target / 'package.json').write_text('existing custom content')
            second = self.run_script('setup.py', target)
            self.assertNotEqual(second.returncode, 0)
            self.assertIn('Refusing to overwrite', second.stderr)
            self.assertEqual((target / 'package.json').read_text(), 'existing custom content')

    def test_status_missing_fresh_stale_and_malformed(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            self.assertEqual(json.loads(self.run_script('status.py', target).stdout)['state'], 'unknown')
            runtime = target / '.runtime'
            runtime.mkdir()
            status = runtime / 'status.json'
            status.write_text(json.dumps({'pid': os.getpid(), 'state': 'online', 'threadId': 'test-thread'}))
            value = json.loads(self.run_script('status.py', target).stdout)
            self.assertTrue(value['processAlive'])
            self.assertTrue(value['fresh'])
            self.assertEqual(value['threadId'], 'test-thread')
            os.utime(status, (1, 1))
            self.assertFalse(json.loads(self.run_script('status.py', target).stdout)['fresh'])
            status.write_text('{bad json')
            self.assertNotEqual(self.run_script('status.py', target).returncode, 0)


if __name__ == '__main__':
    unittest.main()
