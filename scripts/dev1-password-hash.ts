// Interactive only: the secret is never accepted as a command-line argument or echoed to terminal.
import { hashPassword } from '../src/server/accounts';

if (!process.stdin.isTTY) throw new Error('대화형 터미널에서 실행하세요');
process.stdout.write('전투 실험실 비밀번호 (입력 내용 표시 안 함): ');
const password = await new Promise<string>((resolve, reject) => {
  let value = '';
  process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
  const done = () => { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.removeListener('data', input); process.stdout.write('\n'); };
  const input = (s: string) => {
    for (const c of s) {
      if (c === '\u0003') { done(); reject(new Error('취소됨')); return; }
      if (c === '\r' || c === '\n') { done(); resolve(value); return; }
      if (c === '\u007f' || c === '\b') value = value.slice(0, -1);
      else if (c >= ' ' && value.length < 128) value += c;
    }
  };
  process.stdin.on('data', input);
});
if (password.length < 8) throw new Error('비밀번호는 8자 이상이어야 합니다');
console.log(await hashPassword(password));
