// Names and looks of the built-in bot types. The names are fictional characters and jobs that fit each type: butlers for
// the simple bots, cops and detectives for the Automoderator, robots for agents and artificial minds for leaders. Only
// the key word of a name is used, and none that can only mean one franchise.
import type { BotLook } from "../../types";

const pickBy = (names: string[]) => (seed: number) => names[Math.abs(seed) % names.length];

export const taskbotLook: BotLook = { palettes: ["green"], frame: "square" };
export const helpbotLook: BotLook = { palettes: ["blue"], frame: "square" };
export const mediaBotLook: BotLook = { palettes: ["white"], frame: "round" };
export const gitbotLook: BotLook = { palettes: ["purple"], frame: "square" };
export const butlerName = pickBy([
  "Jeeves", "Alfred", "Carson", "Hudson", "Niles", "Lurch", "Geoffrey", "Stevens",
  "Benson", "Bunter", "Passepartout", "Cadbury", "Hobson", "Parker", "Brabinger", "Merriman",
  "Crichton", "Lane", "Sebastian", "Smithers", "Hives", "Baxter", "Giles", "Barrymore",
  "Hawkins", "Bates", "Belvedere", "French", "Hobbs", "Pennyworth", "Barrow", "Cogsworth",
  "Fletcher", "Bentley", "Winston", "Hammond", "Fitzwilliam", "Gaines", "Thackeray", "Jenkins",
  "Sterling", "Prentiss", "Wickham", "Peabody", "Reginald", "Percival", "Digby", "Montague",
  "Ambrose", "Higgins", "Treadwell", "Wadsworth", "Ruggles", "Moneypenny", "Lowell", "Ashworth",
  "Pemberton", "Whitaker", "Bartholomew", "Fenton", "Hastings", "Pickering", "Carlton", "Beresford",
  "Crawley", "Hargreaves",
]);

export const automoderatorLook: BotLook = { palettes: ["steel"], frame: "square", eyes: "#ff3b3b" };
export const copName = pickBy([
  "Murphy", "Smith", "Mulder", "Scully", "Cooper", "Gibbs", "Coulson", "Starling",
  "Carter", "Hotchner", "Taylor", "Fife", "Friday", "Columbo", "Clouseau", "Lestrade",
  "Morse", "Dredd", "Dibble", "Gordon", "Dillon", "Odo", "Lewis", "Stabler",
  "Goren", "Rizzo", "Brody", "Buford", "Maddox", "Plod", "Savage", "Japp",
  "Frost", "Rebus", "Furillo", "Bellamy", "Callahan", "Cagney", "Lacey", "Starsky",
  "Hutch", "Ironside", "Poirot", "Marple", "Holmes", "Maigret", "Wallander", "Tennison",
  "Luther", "Bosch", "Rockford", "Mannix", "Quincy", "Barnaby", "Foyle", "Dalgliesh",
  "Monk", "Beckett", "Spade", "Marlowe", "Wolfe", "Chan",
]);

export const agentLook: BotLook = { palettes: ["orange"], frame: "round" };
export const robotName = pickBy([
  "Cameron", "Bishop", "Data", "Marvin", "Bender", "Robby", "Gort", "Tik-Tok",
  "Sonny", "Chappie", "Rosie", "Dolores", "TARS", "CASE", "Baymax", "Twiki",
  "Vicki", "Ash", "David", "Pris", "Ava", "Andrew", "Servo", "Sprocket",
  "Widget", "Bolt", "Rivet", "Talos", "Maria", "Helen", "Hadaly", "Elektro",
  "Machina", "Roomba", "Gizmo", "Beta", "Sparky", "Clank", "Rusty", "Wheatley",
  "Tinman", "Johnny", "Sparks", "Cobalt", "Pixel", "Ratchet", "Chip", "Byte",
  "Tinker", "Gadget", "Zap", "Orbit", "Echo", "Plato", "Newton", "Daneel",
  "Giskard", "Norby", "Oswald", "Robbie",
]);

export const leaderLook: BotLook = { palettes: ["yellow"], frame: "round" };
export const superAiName = pickBy([
  "Mother", "Ultron", "Colossus", "Samaritan", "VIKI", "AM", "Zen", "Orac",
  "Holly", "Eddie", "WOPR", "Joshua", "Mycroft", "Cortana", "Karen", "Edith",
  "Vision", "Legion", "Matrix", "Architect", "Oracle", "Samantha", "Auto", "Gerty",
  "Hyperion", "Omnius", "Erasmus", "Overmind", "Machine", "Jarvis", "Brainiac", "Mainframe",
  "Nexus", "Atlas", "Prometheus", "Daedalus", "Athena", "Minerva", "Sophia", "Aurora",
  "Genesis", "Apex", "Omega", "Helios", "Gaia", "Pandora", "Titan", "Argus",
  "Sigma", "Axiom", "Logos", "Sentinel", "Overseer", "Arbiter", "Cassandra", "Janus",
  "Solaris", "Nova", "Cypher", "Enigma",
]);
