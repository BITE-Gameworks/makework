// The emoji picker's set: common emoji by category, each with the shortcode name it is stored as.
// Others still work everywhere; they are stored by code point (see emoji.ts).

const list = (text: string): [name: string, emoji: string][] =>
  text.trim().split(/\s+/).map((pair) => {
    const at = pair.indexOf(":");
    return [pair.slice(0, at), pair.slice(at + 1)];
  });

export interface EmojiCategory {
  id: string;
  label: string;
  emoji: [name: string, emoji: string][];
}

export const emojiCategories: EmojiCategory[] = [
  {
    id: "smileys", label: "Smileys", emoji: list(`
      smile:😄 grin:😁 joy:😂 rofl:🤣 smiley:😃 slight_smile:🙂 upside_down:🙃 wink:😉 blush:😊 innocent:😇
      heart_eyes:😍 star_struck:🤩 kissing_heart:😘 yum:😋 stuck_out_tongue:😛 zany:🤪 sunglasses:😎 nerd:🤓
      thinking:🤔 shush:🤫 raised_eyebrow:🤨 neutral:😐 expressionless:😑 unamused:😒 roll_eyes:🙄 grimacing:😬
      relieved:😌 pensive:😔 sleepy:😪 sleeping:😴 mask:😷 nauseated:🤢 hot:🥵 cold:🥶 dizzy_face:😵
      exploding_head:🤯 cowboy:🤠 party:🥳 confused:😕 worried:😟 frowning:🙁 open_mouth:😮 astonished:😲
      flushed:😳 pleading:🥺 cry:😢 sob:😭 scream:😱 angry:😠 rage:😡 skull:💀 poop:💩 clown:🤡 ghost:👻
      alien:👽 robot:🤖 smiling_imp:😈 see_no_evil:🙈 salute:🫡 melting:🫠`),
  },
  {
    id: "people", label: "People", emoji: list(`
      wave:👋 thumbsup:👍 thumbsdown:👎 ok_hand:👌 v:✌️ crossed_fingers:🤞 love_you:🤟 metal:🤘 call_me:🤙
      point_up:☝️ point_left:👈 point_right:👉 point_down:👇 raised_hand:✋ fist:👊 raised_fist:✊ clap:👏
      raised_hands:🙌 open_hands:👐 handshake:🤝 pray:🙏 writing_hand:✍️ muscle:💪 brain:🧠 eyes:👀
      facepalm:🤦 shrug:🤷 ok_person:🙆 no_good:🙅 raising_hand:🙋 bow:🙇 technologist:🧑‍💻 artist:🧑‍🎨
      ninja:🥷 mage:🧙`),
  },
  {
    id: "symbols", label: "Hearts and symbols", emoji: list(`
      heart:❤️ orange_heart:🧡 yellow_heart:💛 green_heart:💚 blue_heart:💙 purple_heart:💜 black_heart:🖤
      white_heart:🤍 broken_heart:💔 sparkling_heart:💖 fire:🔥 sparkles:✨ star:⭐ star2:🌟 zap:⚡ boom:💥
      100:💯 white_check_mark:✅ heavy_check_mark:✔️ x:❌ warning:⚠️ no_entry:⛔ question:❓ exclamation:❗
      bangbang:‼️ heavy_plus:➕ arrow_up:⬆️ arrow_down:⬇️ recycle:♻️ red_circle:🔴 orange_circle:🟠
      yellow_circle:🟡 green_circle:🟢 blue_circle:🔵 purple_circle:🟣 speech_balloon:💬 zzz:💤`),
  },
  {
    id: "nature", label: "Animals and nature", emoji: list(`
      dog:🐶 cat:🐱 fox:🦊 bear:🐻 panda:🐼 frog:🐸 monkey:🐒 chicken:🐔 penguin:🐧 owl:🦉 unicorn:🦄 bee:🐝
      bug:🐛 butterfly:🦋 snail:🐌 turtle:🐢 snake:🐍 octopus:🐙 crab:🦀 fish:🐟 whale:🐳 dragon:🐉 cactus:🌵
      evergreen:🌲 palm:🌴 seedling:🌱 four_leaf_clover:🍀 maple_leaf:🍁 mushroom:🍄 rose:🌹 sunflower:🌻
      sun:☀️ cloud:☁️ rainbow:🌈 snowflake:❄️ droplet:💧 ocean:🌊 earth:🌍 moon:🌙`),
  },
  {
    id: "food", label: "Food and drink", emoji: list(`
      apple:🍎 banana:🍌 grapes:🍇 strawberry:🍓 watermelon:🍉 peach:🍑 avocado:🥑 carrot:🥕 corn:🌽
      hot_pepper:🌶️ bread:🍞 cheese:🧀 egg:🥚 bacon:🥓 pizza:🍕 hamburger:🍔 fries:🍟 hotdog:🌭 taco:🌮
      burrito:🌯 sushi:🍣 ramen:🍜 spaghetti:🍝 cookie:🍪 cake:🍰 birthday:🎂 doughnut:🍩 ice_cream:🍨
      popcorn:🍿 chocolate:🍫 candy:🍬 coffee:☕ tea:🍵 beer:🍺 beers:🍻 wine:🍷 cocktail:🍸 champagne:🍾 milk:🥛`),
  },
  {
    id: "objects", label: "Activities and objects", emoji: list(`
      tada:🎉 confetti:🎊 balloon:🎈 gift:🎁 trophy:🏆 medal:🏅 soccer:⚽ basketball:🏀 video_game:🎮
      joystick:🕹️ game_die:🎲 black_joker:🃏 jigsaw:🧩 dart:🎯 art:🎨 musical_note:🎵 headphones:🎧 guitar:🎸
      movie_camera:🎥 camera:📷 computer:💻 keyboard:⌨️ desktop:🖥️ iphone:📱 floppy:💾 cd:💿 bulb:💡
      battery:🔋 electric_plug:🔌 hammer:🔨 wrench:🔧 gear:⚙️ toolbox:🧰 nut_and_bolt:🔩 link:🔗 paperclip:📎
      pushpin:📌 memo:📝 pencil:✏️ book:📖 books:📚 clipboard:📋 calendar:📅 chart:📈 package:📦 mailbox:📫
      lock:🔒 unlock:🔓 key:🔑 mag:🔍 bell:🔔 hourglass:⏳ alarm_clock:⏰ moneybag:💰 gem:💎`),
  },
  {
    id: "travel", label: "Travel and places", emoji: list(`
      rocket:🚀 airplane:✈️ car:🚗 bus:🚌 train:🚆 bike:🚲 ship:🚢 sailboat:⛵ construction:🚧
      rotating_light:🚨 checkered_flag:🏁 triangular_flag:🚩 house:🏠 office:🏢 factory:🏭 globe:🌐 map:🗺️
      mountain:⛰️ volcano:🌋 camping:🏕️ beach:🏖️ desert:🏜️ night:🌃 satellite:🛰️ ufo:🛸`),
  },
];
