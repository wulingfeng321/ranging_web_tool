"""Set a password hash without storing a plaintext password or a default password."""
import argparse
import getpass
import hashlib
import json
import os
import secrets
import tempfile
from pathlib import Path

parser=argparse.ArgumentParser()
parser.add_argument('--output',type=Path,default=Path(__file__).resolve().parents[1]/'config/admin.local.json')
args=parser.parse_args()
password=getpass.getpass('New admin password: ')
if not password or len(password)>128: raise SystemExit('Password must contain 1 to 128 characters.')
if password!=getpass.getpass('Confirm password: '): raise SystemExit('Passwords do not match.')
salt=secrets.token_bytes(16)
data={'salt':salt.hex(),'hash':hashlib.scrypt(password.encode(),salt=salt,n=16384,r=8,p=1,dklen=32).hex()}
args.output.parent.mkdir(parents=True,exist_ok=True)
fd,name=tempfile.mkstemp(dir=args.output.parent)
try:
    with os.fdopen(fd,'w',encoding='utf-8') as file: json.dump(data,file)
    os.chmod(name,0o600)
    os.replace(name,args.output)
finally:
    if os.path.exists(name): os.unlink(name)
print('Admin password hash saved. Restart the service to invalidate previous sessions.')
