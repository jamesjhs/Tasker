import { getDb } from './db';
import crypto from 'crypto';

const ADJ = [
  'Airy','Amber','Azure','Bold','Brave','Bright','Brisk','Calm','Clear','Cool',
  'Crisp','Dark','Dawn','Deep','Deft','Dusk','Fair','Firm','Fleet','Free',
  'Fresh','Gentle','Gilt','Gold','Grand','Green','Grey','High','Jade','Just',
  'Keen','Kind','Late','Light','Long','Mint','Mist','Moon','Moss','Neat',
  'Noble','North','Oak','Open','Pale','Peak','Pine','Plain','Prime','Proud',
  'Pure','Quick','Quiet','Rain','Rapid','Rare','Rich','Rosy','Round','Royal',
  'Ruby','Safe','Salt','Sandy','Shady','Sharp','Silver','Slim','Smart','Snow',
  'Soft','Solid','South','Spare','Star','Steel','Still','Stone','Storm','Stout',
  'Strong','Sun','Sunny','Sure','Tall','Tame','Teal','True','Twin','Vale',
  'Vast','Vivid','Warm','Wary','West','Wide','Wild','Wise','Young','Zen',
];

const NOUN = [
  'Anchor','Arrow','Ash','Bark','Bear','Bird','Birch','Blade','Blaze','Bloom',
  'Bolt','Brook','Cedar','Cliff','Cloud','Cove','Creek','Crest','Crow','Deer',
  'Dell','Dove','Drake','Dune','Eagle','Echo','Elm','Fern','Finch','Flame',
  'Flask','Fleet','Flint','Flow','Fog','Ford','Fox','Frost','Gate','Glen',
  'Grove','Hawk','Heath','Heron','Hill','Horn','Isle','Ivy','Kite','Lake',
  'Lark','Leaf','Lily','Loch','Lynx','Marsh','Meadow','Mill','Mint','Moon',
  'Moss','Moth','Oak','Path','Peak','Pine','Pool','Pond','Rain','Reed',
  'Ridge','River','Robin','Rock','Rose','Rush','Sage','Sand','Seed','Shore',
  'Slope','Snow','Spring','Star','Stone','Storm','Stream','Swift','Tern','Thorn',
  'Tide','Trail','Tree','Vale','Vine','Wave','Well','Willow','Wren','Yew',
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
