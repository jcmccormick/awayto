import { createInterface } from 'readline';
import { writeFile, readFile } from 'fs/promises';

const ask = (q: string = '', invalid?: RegExp, valid?: RegExp): Promise<string> => new Promise((resolve, reject) => {

  var rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  rl.question(invalid ? `${q} Invalid Characters: ${invalid}\n> ` : q, async function (answer) {
    if (answer.length && invalid && invalid.test(answer)) {
      console.log('Invalid character found.\n');
      resolve(await ask(q, invalid, valid));
    }
    if (answer.length && valid && !valid.test(answer)) {
      console.log('Invalid character found.\n');
      resolve(await ask(q, invalid, valid));
    }
    resolve(answer);
  });
})

const replaceText = (file, from, to) => new Promise(async (resolve, reject) => {

  try {

    const oldFile = await readFile(file, 'utf8');
    
    var result = oldFile.replaceAll(`##${from}##`, to);
  
    await writeFile(file, result, 'utf8');
  
    resolve(true);

  } catch (error) {
    console.log('error replacing text', error);
    reject();
  }

});

const asyncForEach = async (array, callback) => {
  if (array && array.length) {
    for (let index = 0; index < array.length; index++) {
      await callback(array[index], index, array);
    }
  }
}

const makeLambdaPayload = (body) => {
  const str = JSON.stringify(body);
  const payload = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    payload[i] = str.charCodeAt(i);
  }
  return payload;
}

const makeLoader = () => {
  let counter = 1;
  return setInterval(function () {
    process.stdout.write("\r\x1b[K")
    process.stdout.write(`${counter % 2 == 0 ? '-' : '|'}`);
    counter++;
  }, 250)
}

const loadMessage = (msg) => {
  process.stdout.write(`\r\x1b[K${msg}\n`);
}

export { ask, replaceText, asyncForEach, makeLambdaPayload, makeLoader, loadMessage };