import os, pty, subprocess, tempfile, select, time, json, shutil
cli=os.path.abspath('dist/index.js');node=shutil.which('node')
with tempfile.TemporaryDirectory(prefix='agenthub-terminal-check-') as root:
 subprocess.run([node,cli,'init'],cwd=root,check=True,stdout=subprocess.DEVNULL)
 fake=os.path.join(root,'fake-codex')
 with open(fake,'w') as f:f.write('#!'+node+'\nconsole.log("FAKE_NATIVE_TERMINAL_OK");\n')
 os.chmod(fake,0o755)
 subprocess.run([node,cli,'config','agent','codex','--interactive-command',fake],cwd=root,check=True,stdout=subprocess.DEVNULL)
 master,slave=pty.openpty();proc=subprocess.Popen([node,cli,'start'],cwd=root,stdin=slave,stdout=slave,stderr=slave);os.close(slave)
 pending=b'';transcript=b''
 def expect(needle):
  global pending,transcript
  deadline=time.monotonic()+6
  while needle not in pending:
   if time.monotonic()>deadline:raise RuntimeError('Timed out '+repr(needle)+repr(transcript))
   if select.select([master],[],[],0.2)[0]:
    chunk=os.read(master,8192);pending+=chunk;transcript+=chunk
  pending=pending.split(needle,1)[1]
 try:
  expect(b'Choose 1');os.write(master,b'4\n')
  expect(b'Worktree (existing/auto/none):');os.write(master,b'none\n')
  expect(b'Task ID (blank for none):');os.write(master,b'\n')
  expect(b'FAKE_NATIVE_TERMINAL_OK');expect(b'Choose 1');os.write(master,b'9\n')
  end=time.monotonic()+5
  while proc.poll() is None and time.monotonic()<end:
   if select.select([master],[],[],0.1)[0]:
    try:transcript+=os.read(master,8192)
    except OSError:break
  assert proc.wait(timeout=1)==0
  files=os.listdir(os.path.join(root,'.agenthub','sessions'))
  with open(os.path.join(root,'.agenthub','sessions',files[0])) as f:record=json.load(f)
  assert record['exitCode']==0 and record['endedAt']
  print('PASS: PTY menu -> fake native attach -> menu -> exit; session recorded.')
 except:print(repr(transcript));raise
 finally:
  if proc.poll() is None:proc.kill();proc.wait()
  os.close(master)
