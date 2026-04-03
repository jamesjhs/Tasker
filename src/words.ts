import { getDb } from './db';
import crypto from 'crypto';

const ADJ = [
  'Amber','Azure','Bold','Brave','Bright','Calm','Clear','Cool','Crisp','Dark',
  'Dawn','Deep','Deft','Fair','Firm','Fleet','Free','Fresh','Gentle','Gold',
  'Grand','Green','Grey','High','Jade','Just','Keen','Kind','Late','Light',
  'Long','Mint','Mist','Moon','Moss','Neat','Noble','North','Oak','Open',
  'Peak','Pine','Plain','Proud','Pure','Quick','Quiet','Rain','Rapid','Rare',
  'Rich','Rosy','Round','Royal','Ruby','Safe','Salt','Sharp','Silver','Slim',
  'Smart','Snow','Soft','Solid','South','Star','Steel','Still','Stone','Storm',
  'Strong','Sun','Sure','Tall','Tame','Teal','True','Twin','Vale','Vast',
  'Warm','West','Wide','Wild','Wise','Young','Zen',
];

const NOUN = [
  'Anchor','Arrow','Ash','Bark','Bear','Bird','Blade','Bloom','Bolt','Brook',
  'Cedar','Cloud','Cove','Creek','Crow','Deer','Dell','Dove','Drake','Dune',
  'Eagle','Echo','Elm','Fern','Finch','Flame','Flask','Fleet','Flint','Flow',
  'Fog','Ford','Fox','Frost','Gate','Glen','Grove','Hawk','Heath','Hill',
  'Horn','Isle','Ivy','Kite','Lake','Lark','Leaf','Lily','Loch','Lynx',
  'Marsh','Meadow','Mill','Mint','Moon','Moss','Moth','Oak','Path','Peak',
  'Pine','Pool','Pond','Rain','Reed','Ridge','River','Rock','Rose','Rush',
  'Sage','Sand','Seed','Shore','Slope','Snow','Spring','Star','Stone','Storm',
  'Stream','Swift','Thorn','Tide','Trail','Tree','Vale','Vine','Wave','Well',
  'Wren','Yew',
];

function pick(arr: string[]): string {
  const idx = crypto.randomInt(arr.length);
  return arr[idx];
}

export function generateUsername(): string {
  const db = getDb();
  const check = db.prepare('SELECT id FROM users WHERE username=?');
  for (let i = 0; i < 200; i++) {
    const name = pick(ADJ) + pick(NOUN);
    if (!check.get(name)) return name;
  }
  return pick(ADJ) + pick(NOUN) + crypto.randomInt(1000);
}
