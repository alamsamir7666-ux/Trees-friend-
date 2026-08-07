import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  Smile,
  Search,
  Clock,
  SmileIcon,
  HeartIcon,
  HandIcon,
  CatIcon,
  CoffeeIcon,
  BallIcon,
  PlaneIcon,
  BulbIcon,
  FlagIcon,
  X,
} from "./emojiIcons";

// ─── Emoji catalog ─────────────────────────────────────────────────────────
// Source: Unicode CLDR short names + curated subsets. We intentionally do
// NOT bundle the full 1800+ emoji set — that would balloon the JS bundle
// by ~150KB. Instead we ship a hand-picked ~600-emoji catalog covering
// the categories most used in messaging (Smileys, Gestures, Hearts,
// Animals, Food, Activities, Travel, Objects, Symbols, Flags) with the
// skin-tone modifier pattern for human-form emoji.
//
// Each entry is the base emoji (no skin tone). The picker applies the
// selected skin tone at runtime by replacing the standard "person"
// emoji with its modifier form (see `applySkinTone` below).

interface EmojiItem {
  e: string; // base emoji
  n: string; // short name (lowercase, space-separated)
  k?: boolean; // keyword-only flag: this emoji supports skin tone
}

// Smileys & Emotion — faces, hearts
const SMILEYS: EmojiItem[] = [
  { e: "😀", n: "grinning" }, { e: "😃", n: "smiley" }, { e: "😄", n: "smile" },
  { e: "😁", n: "grin" }, { e: "😆", n: "laughing" }, { e: "😅", n: "sweat smile" },
  { e: "🤣", n: "rofl" }, { e: "😂", n: "joy" }, { e: "🙂", n: "slight smile" },
  { e: "🙃", n: "upside down" }, { e: "😉", n: "wink" }, { e: "😊", n: "blush" },
  { e: "😇", n: "innocent" }, { e: "🥰", n: "smiling hearts" }, { e: "😍", n: "heart eyes" },
  { e: "🤩", n: "star struck" }, { e: "😘", n: "kissing heart" }, { e: "😗", n: "kissing" },
  { e: "😚", n: "kissing closed eyes" }, { e: "😙", n: "kissing smiling eyes" },
  { e: "😋", n: "yum" }, { e: "😛", n: "tongue" }, { e: "😜", n: "wink tongue" },
  { e: "🤪", n: "zany" }, { e: "🤨", n: "raised eyebrow" }, { e: "🧐", n: "monocle" },
  { e: "🤓", n: "nerd" }, { e: "😎", n: "cool" }, { e: "🥸", n: "disguise" },
  { e: "🤩", n: "wow" }, { e: "🥳", n: "party" }, { e: "😏", n: "smirk" },
  { e: "😒", n: "unamused" }, { e: "😞", n: "disappointed" }, { e: "😔", n: "pensive" },
  { e: "😟", n: "worried" }, { e: "😕", n: "confused" }, { e: "🙁", n: "slight frown" },
  { e: "☹️", n: "frown" }, { e: "😣", n: "persevere" }, { e: "😖", n: "confounded" },
  { e: "😫", n: "tired" }, { e: "😩", n: "weary" }, { e: "🥺", n: "pleading" },
  { e: "😢", n: "cry" }, { e: "😭", n: "sob" }, { e: "😤", n: "triumph" },
  { e: "😠", n: "angry" }, { e: "😡", n: "rage" }, { e: "🤬", n: "cursing" },
  { e: "🤯", n: "exploding head" }, { e: "😳", n: "flushed" }, { e: "🥵", n: "hot" },
  { e: "🥶", n: "cold" }, { e: "😱", n: "scream" }, { e: "😨", n: "fearful" },
  { e: "😰", n: "anxious sweat" }, { e: "😥", n: "sad relieved" }, { e: "😓", n: "sweat" },
  { e: "🤗", n: "hug" }, { e: "🤔", n: "thinking" }, { e: "🤭", n: "hand over mouth" },
  { e: "🤫", n: "shushing" }, { e: "🤥", n: "lying" }, { e: "😶", n: "no mouth" },
  { e: "😐", n: "neutral" }, { e: "😑", n: "expressionless" }, { e: "😬", n: "grimacing" },
  { e: "🙄", n: "eye roll" }, { e: "😯", n: "hushed" }, { e: "😦", n: "frowning open" },
  { e: "😧", n: "anguished" }, { e: "😮", n: "open mouth" }, { e: "😲", n: "astonished" },
  { e: "🥱", n: "yawn" }, { e: "😴", n: "sleep" }, { e: "🤤", n: "drool" },
  { e: "😪", n: "sleepy" }, { e: "😵", n: "dizzy" }, { e: "🤐", n: "zipper mouth" },
  { e: "🥴", n: "woozy" }, { e: "🤢", n: "nauseated" }, { e: "🤮", n: "vomit" },
  { e: "🤧", n: "sneeze" }, { e: "😷", n: "mask" }, { e: "🤒", n: "thermometer" },
  { e: "🤕", n: "bandage" }, { e: "🤑", n: "money mouth" }, { e: "🤠", n: "cowboy" },
  { e: "😈", n: "smiling devil" }, { e: "👿", n: "angry devil" }, { e: "👻", n: "ghost" },
  { e: "💀", n: "skull" }, { e: "☠️", n: "skull crossbones" }, { e: "👽", n: "alien" },
  { e: "🤖", n: "robot" }, { e: "🎃", n: "pumpkin" }, { e: "😺", n: "smiley cat" },
  { e: "😸", n: "smile cat" }, { e: "😹", n: "joy cat" }, { e: "😻", n: "heart eyes cat" },
  { e: "😼", n: "smirk cat" }, { e: "😽", n: "kissing cat" }, { e: "🙀", n: "scream cat" },
  { e: "😿", n: "crying cat" }, { e: "😾", n: "pouting cat" },
  // Hearts
  { e: "❤️", n: "red heart" }, { e: "🧡", n: "orange heart" }, { e: "💛", n: "yellow heart" },
  { e: "💚", n: "green heart" }, { e: "💙", n: "blue heart" }, { e: "💜", n: "purple heart" },
  { e: "🖤", n: "black heart" }, { e: "🤍", n: "white heart" }, { e: "🤎", n: "brown heart" },
  { e: "💔", n: "broken heart" }, { e: "❣️", n: "heart exclamation" }, { e: "💕", n: "two hearts" },
  { e: "💞", n: "revolving hearts" }, { e: "💓", n: "beating heart" }, { e: "💗", n: "growing heart" },
  { e: "💖", n: "sparkling heart" }, { e: "💘", n: "cupid" }, { e: "💝", n: "gift heart" },
  { e: "💟", n: "heart decoration" }, { e: "♥️", n: "heart suit" },
];

// People & Gestures (skin-tone capable where marked)
const PEOPLE: EmojiItem[] = [
  { e: "👋", n: "wave", k: true }, { e: "🤚", n: "raised back", k: true }, { e: "✋", n: "raised hand", k: true },
  { e: "🖐️", n: "hand fingers splayed", k: true }, { e: "🖖", n: "vulcan", k: true }, { e: "👌", n: "ok", k: true },
  { e: "🤌", n: "pinched", k: true }, { e: "🤏", n: "pinching", k: true }, { e: "✌️", n: "peace", k: true },
  { e: "🤞", n: "crossed fingers", k: true }, { e: "🤟", n: "love you", k: true }, { e: "🤘", n: "metal", k: true },
  { e: "🤙", n: "call me", k: true }, { e: "👈", n: "point left", k: true }, { e: "👉", n: "point right", k: true },
  { e: "👆", n: "point up", k: true }, { e: "👇", n: "point down", k: true }, { e: "☝️", n: "point up one", k: true },
  { e: "👍", n: "thumbs up", k: true }, { e: "👎", n: "thumbs down", k: true }, { e: "✊", n: "fist", k: true },
  { e: "👊", n: "punch", k: true }, { e: "🤛", n: "fist left", k: true }, { e: "🤜", n: "fist right", k: true },
  { e: "👏", n: "clap", k: true }, { e: "🙌", n: "raising hands", k: true }, { e: "👐", n: "open hands", k: true },
  { e: "🤲", n: "palms together", k: true }, { e: "🙏", n: "pray", k: true }, { e: "🤝", n: "handshake" },
  { e: "💪", n: "muscle", k: true }, { e: "🫶", n: "heart hands", k: true }, { e: "✍️", n: "writing", k: true },
  { e: "💅", n: "nail polish", k: true }, { e: "🤳", n: "selfie", k: true }, { e: "👀", n: "eyes" },
  { e: "👁️", n: "eye" }, { e: "👅", n: "tongue" }, { e: "👄", n: "mouth" },
  { e: "🦷", n: "tooth" }, { e: "👶", n: "baby", k: true }, { e: "👦", n: "boy", k: true },
  { e: "👧", n: "girl", k: true }, { e: "🧒", n: "child", k: true }, { e: "👨", n: "man", k: true },
  { e: "👩", n: "woman", k: true }, { e: "🧑", n: "person", k: true }, { e: "👵", n: "old woman", k: true },
  { e: "👴", n: "old man", k: true }, { e: "🙇", n: "bow", k: true }, { e: "💁", n: "tipping hand", k: true },
  { e: "🙅", n: "no gesture", k: true }, { e: "🙆", n: "ok gesture", k: true }, { e: "🙋", n: "raising hand", k: true },
  { e: "🧏", n: "deaf person", k: true }, { e: "🤦", n: "facepalm", k: true }, { e: "🤷", n: "shrug", k: true },
  { e: "💆", n: "massage", k: true }, { e: "💇", n: "haircut", k: true }, { e: "🚶", n: "walking", k: true },
  { e: "🧍", n: "standing", k: true }, { e: "🧎", n: "kneeling", k: true }, { e: "🏃", n: "running", k: true },
  { e: "💃", n: "woman dancing", k: true }, { e: "🕺", n: "man dancing", k: true }, { e: "👯", n: "dancers" },
  { e: "🧖", n: "sauna", k: true }, { e: "🧗", n: "climbing", k: true }, { e: "🤺", n: "fencing" },
  { e: "🏇", n: "horse racing", k: true }, { e: "⛷️", n: "skier" }, { e: "🏂", n: "snowboarder", k: true },
  { e: "🏌️", n: "golfing", k: true }, { e: "🏄", n: "surfing", k: true }, { e: "🚣", n: "rowing", k: true },
  { e: "🏊", n: "swimming", k: true }, { e: "🏀", n: "basketball player", k: true }, { e: "🏋️", n: "weight lifting", k: true },
  { e: "🚴", n: "biking", k: true }, { e: "🚵", n: "mountain biking", k: true }, { e: "🤸", n: "cartwheel", k: true },
  { e: "🤼", n: "wrestling" }, { e: "🤽", n: "water polo", k: true }, { e: "🤾", n: "handball", k: true },
  { e: "🤹", n: "juggling", k: true }, { e: "🛀", n: "bath", k: true }, { e: "🛌", n: "sleeping", k: true },
];

// Animals & Nature
const ANIMALS: EmojiItem[] = [
  { e: "🐶", n: "dog" }, { e: "🐱", n: "cat" }, { e: "🐭", n: "mouse" }, { e: "🐹", n: "hamster" },
  { e: "🐰", n: "rabbit" }, { e: "🦊", n: "fox" }, { e: "🐻", n: "bear" }, { e: "🐼", n: "panda" },
  { e: "🐻‍❄️", n: "polar bear" }, { e: "🐨", n: "koala" }, { e: "🐯", n: "tiger" }, { e: "🦁", n: "lion" },
  { e: "🐮", n: "cow" }, { e: "🐷", n: "pig" }, { e: "🐸", n: "frog" }, { e: "🐵", n: "monkey" },
  { e: "🙈", n: "see no evil" }, { e: "🙉", n: "hear no evil" }, { e: "🙊", n: "speak no evil" },
  { e: "🐒", n: "monkey" }, { e: "🐔", n: "chicken" }, { e: "🐧", n: "penguin" }, { e: "🐦", n: "bird" },
  { e: "🐤", n: "baby chick" }, { e: "🦆", n: "duck" }, { e: "🦅", n: "eagle" }, { e: "🦉", n: "owl" },
  { e: "🦇", n: "bat" }, { e: "🐺", n: "wolf" }, { e: "🐗", n: "boar" }, { e: "🐴", n: "horse" },
  { e: "🦄", n: "unicorn" }, { e: "🐝", n: "bee" }, { e: "🐛", n: "bug" }, { e: "🦋", n: "butterfly" },
  { e: "🐌", n: "snail" }, { e: "🐞", n: "ladybug" }, { e: "🐜", n: "ant" }, { e: "🦗", n: "cricket" },
  { e: "🕷️", n: "spider" }, { e: "🦂", n: "scorpion" }, { e: "🐢", n: "turtle" }, { e: "🐍", n: "snake" },
  { e: "🦎", n: "lizard" }, { e: "🦖", n: "t-rex" }, { e: "🦕", n: "sauropod" }, { e: "🐙", n: "octopus" },
  { e: "🦑", n: "squid" }, { e: "🦐", n: "shrimp" }, { e: "🦞", n: "lobster" }, { e: "🦀", n: "crab" },
  { e: "🐡", n: "blowfish" }, { e: "🐠", n: "tropical fish" }, { e: "🐟", n: "fish" }, { e: "🐬", n: "dolphin" },
  { e: "🐳", n: "whale" }, { e: "🐋", n: "whale 2" }, { e: "🦈", n: "shark" }, { e: "🐊", n: "crocodile" },
  { e: "🐅", n: "tiger 2" }, { e: "🐆", n: "leopard" }, { e: "🦓", n: "zebra" }, { e: "🦍", n: "gorilla" },
  { e: "🦧", n: "orangutan" }, { e: "🐘", n: "elephant" }, { e: "🦣", n: "mammoth" }, { e: "🦏", n: "rhino" },
  { e: "🦛", n: "hippo" }, { e: "🐪", n: "camel" }, { e: "🐫", n: "two hump camel" }, { e: "🦒", n: "giraffe" },
  { e: "🦘", n: "kangaroo" }, { e: "🦬", n: "bison" }, { e: "🐃", n: "water buffalo" }, { e: "🐂", n: "ox" },
  { e: "🐄", n: "cow 2" }, { e: "🐎", n: "horse 2" }, { e: "🐖", n: "pig 2" }, { e: "🐏", n: "ram" },
  { e: "🐑", n: "ewe" }, { e: "🦙", n: "llama" }, { e: "🐐", n: "goat" }, { e: "🦌", n: "deer" },
  { e: "🐕", n: "dog 2" }, { e: "🐩", n: "poodle" }, { e: "🦮", n: "guide dog" }, { e: "🐕‍🦺", n: "service dog" },
  { e: "🐈", n: "cat 2" }, { e: "🐈‍⬛", n: "black cat" }, { e: "🐓", n: "rooster" }, { e: "🦃", n: "turkey" },
  { e: "🦚", n: "peacock" }, { e: "🦜", n: "parrot" }, { e: "🦢", n: "swan" }, { e: "🦩", n: "flamingo" },
  { e: "🕊️", n: "dove" }, { e: "🐇", n: "rabbit 2" }, { e: "🦝", n: "raccoon" }, { e: "🦨", n: "skunk" },
  { e: "🦡", n: "badger" }, { e: "🦫", n: "beaver" }, { e: "🦦", n: "otter" }, { e: "🦥", n: "sloth" },
  { e: "🐁", n: "mouse 2" }, { e: "🐀", n: "rat" }, { e: "🐿️", n: "chipmunk" }, { e: "🦔", n: "hedgehog" },
  // Plants & nature
  { e: "🌸", n: "cherry blossom" }, { e: "💮", n: "white flower" }, { e: "🏵️", n: "rosette" },
  { e: "🌹", n: "rose" }, { e: "🥀", n: "wilted flower" }, { e: "🌺", n: "hibiscus" },
  { e: "🌻", n: "sunflower" }, { e: "🌼", n: "blossom" }, { e: "🌷", n: "tulip" },
  { e: "🌱", n: "seedling" }, { e: "🌲", n: "evergreen tree" }, { e: "🌳", n: "deciduous tree" },
  { e: "🌴", n: "palm tree" }, { e: "🌵", n: "cactus" }, { e: "🌾", n: "sheaf of rice" },
  { e: "🌿", n: "herb" }, { e: "☘️", n: "shamrock" }, { e: "🍀", n: "four leaf clover" },
  { e: "🍁", n: "maple leaf" }, { e: "🍂", n: "fallen leaf" }, { e: "🍃", n: "leaf fluttering" },
  { e: "🌍", n: "globe europe" }, { e: "🌎", n: "globe americas" }, { e: "🌏", n: "globe asia" },
  { e: "🌕", n: "full moon" }, { e: "🌙", n: "crescent moon" }, { e: "⭐", n: "star" },
  { e: "🌟", n: "glowing star" }, { e: "✨", n: "sparkles" }, { e: "⚡", n: "zap" },
  { e: "🔥", n: "fire" }, { e: "💧", n: "droplet" }, { e: "🌊", n: "wave" },
];

// Food & Drink
const FOOD: EmojiItem[] = [
  { e: "🍏", n: "green apple" }, { e: "🍎", n: "red apple" }, { e: "🍐", n: "pear" }, { e: "🍊", n: "orange" },
  { e: "🍋", n: "lemon" }, { e: "🍌", n: "banana" }, { e: "🍉", n: "watermelon" }, { e: "🍇", n: "grapes" },
  { e: "🍓", n: "strawberry" }, { e: "🫐", n: "blueberries" }, { e: "🍈", n: "melon" }, { e: "🍒", n: "cherries" },
  { e: "🍑", n: "peach" }, { e: "🥭", n: "mango" }, { e: "🍍", n: "pineapple" }, { e: "🥥", n: "coconut" },
  { e: "🥝", n: "kiwi" }, { e: "🍅", n: "tomato" }, { e: "🍆", n: "eggplant" }, { e: "🥑", n: "avocado" },
  { e: "🥦", n: "broccoli" }, { e: "🥬", n: "leafy green" }, { e: "🥒", n: "cucumber" }, { e: "🌶️", n: "hot pepper" },
  { e: "🫑", n: "bell pepper" }, { e: "🌽", n: "corn" }, { e: "🥕", n: "carrot" }, { e: "🫒", n: "olive" },
  { e: "🧄", n: "garlic" }, { e: "🧅", n: "onion" }, { e: "🥔", n: "potato" }, { e: "🍠", n: "sweet potato" },
  { e: "🥐", n: "croissant" }, { e: "🥯", n: "bagel" }, { e: "🍞", n: "bread" }, { e: "🥖", n: "baguette" },
  { e: "🧀", n: "cheese" }, { e: "🥚", n: "egg" }, { e: "🍳", n: "cooking" }, { e: "🧈", n: "butter" },
  { e: "🥞", n: "pancakes" }, { e: "🧇", n: "waffle" }, { e: "🥓", n: "bacon" }, { e: "🥩", n: "steak" },
  { e: "🍗", n: "poultry leg" }, { e: "🍖", n: "meat on bone" }, { e: "🌭", n: "hot dog" },
  { e: "🍔", n: "burger" }, { e: "🍟", n: "fries" }, { e: "🍕", n: "pizza" }, { e: "🥪", n: "sandwich" },
  { e: "🌮", n: "taco" }, { e: "🌯", n: "burrito" }, { e: "🥙", n: "stuffed flatbread" }, { e: "🧆", n: "falafel" },
  { e: "🍜", n: "steaming bowl" }, { e: "🍝", n: "spaghetti" }, { e: "🍲", n: "pot of food" }, { e: "🍛", n: "curry rice" },
  { e: "🍣", n: "sushi" }, { e: "🍱", n: "bento" }, { e: "🥟", n: "dumpling" }, { e: "🦪", n: "oyster" },
  { e: "🍤", n: "fried shrimp" }, { e: "🍙", n: "rice ball" }, { e: "🍚", n: "cooked rice" }, { e: "🍘", n: "rice cracker" },
  { e: "🍥", n: "fish cake" }, { e: "🥠", n: "fortune cookie" }, { e: "🍢", n: "oden" }, { e: "🍡", n: "dango" },
  { e: "🍧", n: "shaved ice" }, { e: "🍨", n: "ice cream" }, { e: "🍦", n: "soft ice cream" }, { e: "🥧", n: "pie" },
  { e: "🧁", n: "cupcake" }, { e: "🍰", n: "shortcake" }, { e: "🎂", n: "birthday cake" }, { e: "🍮", n: "pudding" },
  { e: "🍭", n: "lollipop" }, { e: "🍬", n: "candy" }, { e: "🍫", n: "chocolate bar" }, { e: "🍿", n: "popcorn" },
  { e: "🍩", n: "doughnut" }, { e: "🍪", n: "cookie" }, { e: "🌰", n: "chestnut" }, { e: "🥜", n: "peanuts" },
  { e: "🍯", n: "honey pot" }, { e: "🥛", n: "glass of milk" }, { e: "🍼", n: "baby bottle" }, { e: "☕", n: "coffee" },
  { e: "🍵", n: "teacup" }, { e: "🧃", n: "juice box" }, { e: "🥤", n: "cup straw" }, { e: "🧋", n: "bubble tea" },
  { e: " soda", n: "soda" }, { e: "🥤", n: "cup" }, { e: "🍺", n: "beer" }, { e: "🍻", n: "beers" },
  { e: "🥂", n: "clinking glasses" }, { e: "🍷", n: "wine glass" }, { e: "🥃", n: "tumbler" }, { e: "🍸", n: "cocktail" },
  { e: "🍹", n: "tropical drink" }, { e: "🍾", n: "bottle popping" }, { e: "🧊", n: "ice" }, { e: "🥄", n: "spoon" },
  { e: "🍴", n: "fork knife" }, { e: "🍽️", n: "fork plate" }, { e: "🥣", n: "bowl spoon" }, { e: "🥡", n: "takeout" },
  { e: "🥢", n: "chopsticks" }, { e: "🧂", n: "salt" },
];

// Activities & Sports
const ACTIVITIES: EmojiItem[] = [
  { e: "⚽", n: "soccer" }, { e: "🏀", n: "basketball" }, { e: "🏈", n: "football" }, { e: "⚾", n: "baseball" },
  { e: "🥎", n: "softball" }, { e: "🎾", n: "tennis" }, { e: "🏐", n: "volleyball" }, { e: "🏉", n: "rugby" },
  { e: "🥏", n: "flying disc" }, { e: "🎱", n: "pool 8 ball" }, { e: "🏓", n: "ping pong" }, { e: "🏸", n: "badminton" },
  { e: "🥅", n: "goal net" }, { e: "🏒", n: "hockey" }, { e: "🏑", n: "field hockey" }, { e: "🥍", n: "lacrosse" },
  { e: "🏏", n: "cricket" }, { e: "🪃", n: "boomerang" }, { e: "🥁", n: "drum" }, { e: "🎯", n: "bullseye" },
  { e: "🎳", n: "bowling" }, { e: "🎮", n: "video game" }, { e: "🎰", n: "slot machine" }, { e: "🎲", n: "dice" },
  { e: "🧩", n: "puzzle" }, { e: "♟️", n: "chess pawn" }, { e: "🎭", n: "performing arts" }, { e: "🎨", n: "palette" },
  { e: "🧵", n: "thread" }, { e: "🧶", n: "yarn" }, { e: "🎼", n: "musical score" }, { e: "🎵", n: "musical note" },
  { e: "🎶", n: "musical notes" }, { e: "🎤", n: "microphone" }, { e: "🎧", n: "headphone" }, { e: "🎷", n: "saxophone" },
  { e: "🎸", n: "guitar" }, { e: "🎹", n: "piano" }, { e: "🎺", n: "trumpet" }, { e: "🎻", n: "violin" },
  { e: "🪕", n: "banjo" }, { e: "🥁", n: "drum 2" }, { e: "🎖️", n: "military medal" }, { e: "🏆", n: "trophy" },
  { e: "🏅", n: "sports medal" }, { e: "🥇", n: "1st place" }, { e: "🥈", n: "2nd place" }, { e: "🥉", n: "3rd place" },
  { e: "🎪", n: "circus" }, { e: "🎫", n: "ticket" }, { e: "🎟️", n: "admission tickets" }, { e: "🎬", n: "clapper" },
  { e: "🎥", n: "movie camera" }, { e: "📺", n: "tv" }, { e: "📻", n: "radio" }, { e: "🎧", n: "headphone 2" },
];

// Travel & Places
const TRAVEL: EmojiItem[] = [
  { e: "🚗", n: "car" }, { e: "🚕", n: "taxi" }, { e: "🚙", n: "suv" }, { e: "🚌", n: "bus" },
  { e: "🚎", n: "trolleybus" }, { e: "🏎️", n: "racing car" }, { e: "🚓", n: "police car" }, { e: "🚑", n: "ambulance" },
  { e: "🚒", n: "fire engine" }, { e: "🚐", n: "minibus" }, { e: "🛻", n: "pickup" }, { e: "🚚", n: "truck" },
  { e: "🚛", n: "articulated lorry" }, { e: "🚜", n: "tractor" }, { e: "🏍️", n: "motorcycle" }, { e: "🛵", n: "scooter" },
  { e: "🚲", n: "bicycle" }, { e: "🛴", n: "kick scooter" }, { e: "🛹", n: "skateboard" }, { e: "🛼", n: "roller skate" },
  { e: "🚏", n: "bus stop" }, { e: "🛣️", n: "motorway" }, { e: "🛤️", n: "railway track" }, { e: "⛽", n: "fuel pump" },
  { e: "🚨", n: "police light" }, { e: "🚥", n: "traffic light" }, { e: "🚦", n: "traffic light 2" }, { e: "🛑", n: "stop sign" },
  { e: "🚂", n: "locomotive" }, { e: "🚃", n: "railway car" }, { e: "🚄", n: "high speed train" }, { e: "🚅", n: "bullet train" },
  { e: "🚆", n: "train" }, { e: "🚇", n: "metro" }, { e: "🚈", n: "light rail" }, { e: "🚉", n: "station" },
  { e: "🚊", n: "tram" }, { e: "🚝", n: "monorail" }, { e: "🚞", n: "mountain railway" }, { e: "🚋", n: "tram car" },
  { e: "🚌", n: "bus 2" }, { e: "🚍", n: "oncoming bus" }, { e: "🚎", n: "trolleybus 2" }, { e: "🚐", n: "minibus 2" },
  { e: "🚜", n: "tractor 2" }, { e: "✈️", n: "airplane" }, { e: "🛫", n: "takeoff" }, { e: "🛬", n: "arrival" },
  { e: "🛩️", n: "small airplane" }, { e: "💺", n: "seat" }, { e: "🚁", n: "helicopter" }, { e: "🚟", n: "suspension railway" },
  { e: "🚠", n: "mountain cableway" }, { e: "🚡", n: "aerial tramway" }, { e: "🛰️", n: "satellite" }, { e: "🚀", n: "rocket" },
  { e: "🛸", n: "flying saucer" }, { e: "🚁", n: "helicopter 2" }, { e: "⛵", n: "sailboat" }, { e: "🚤", n: "speedboat" },
  { e: "🛳️", n: "passenger ship" }, { e: "⛴️", n: "ferry" }, { e: "🛥️", n: "motor boat" }, { e: "🚢", n: "ship" },
  { e: "⚓", n: "anchor" }, { e: "🚧", n: "construction" }, { e: "🗼", n: "tokyo tower" }, { e: "🗽", n: "statue of liberty" },
  { e: "🏯", n: "japanese castle" }, { e: "🏰", n: "castle" }, { e: "🏟️", n: "stadium" }, { e: "🎡", n: "ferris wheel" },
  { e: "🎢", n: "roller coaster" }, { e: "🎠", n: "carousel horse" }, { e: "⛲", n: "fountain" }, { e: "⛱️", n: "umbrella ground" },
  { e: "🏖️", n: "beach umbrella" }, { e: "🏝️", n: "desert island" }, { e: "🏜️", n: "desert" }, { e: "🌋", n: "volcano" },
  { e: "⛰️", n: "mountain" }, { e: "🏔️", n: "snow mountain" }, { e: "🗻", n: "fuji" }, { e: "🏕️", n: "camping" },
  { e: "⛺", n: "tent" }, { e: "🏠", n: "house" }, { e: "🏡", n: "house garden" }, { e: "🏘️", n: "houses" },
  { e: "🏚️", n: "derelict house" }, { e: "🏗️", n: "construction 2" }, { e: "🏭", n: "factory" }, { e: "🏢", n: "office" },
  { e: "🏬", n: "department store" }, { e: "🏣", n: "post office" }, { e: "🏤", n: "post office 2" }, { e: "🏥", n: "hospital" },
  { e: "🏦", n: "bank" }, { e: "🏨", n: "hotel" }, { e: "🏪", n: "convenience store" }, { e: "🏫", n: "school" },
  { e: "🏩", n: "love hotel" }, { e: "💒", n: "wedding" }, { e: "🏛️", n: "classical building" }, { e: "⛪", n: "church" },
  { e: "🕌", n: "mosque" }, { e: "🕍", n: "synagogue" }, { e: "🛕", n: "hindu temple" }, { e: "⛩️", n: "shinto shrine" },
  { e: "🕋", n: "kaaba" }, { e: "🌁", n: "foggy" }, { e: "🌃", n: "night stars" }, { e: "🏙️", n: "cityscape" },
  { e: "🌄", n: "sunrise mountains" }, { e: "🌅", n: "sunrise" }, { e: "🌆", n: "city dusk" }, { e: "🌇", n: "sunset" },
  { e: "🌉", n: "bridge night" },
];

// Objects
const OBJECTS: EmojiItem[] = [
  { e: "⌚", n: "watch" }, { e: "📱", n: "phone" }, { e: "📲", n: "phone arrow" }, { e: "💻", n: "laptop" },
  { e: "⌨️", n: "keyboard" }, { e: "🖥️", n: "desktop" }, { e: "🖨️", n: "printer" }, { e: "🖱️", n: "mouse" },
  { e: "🖲️", n: "trackball" }, { e: "🕹️", n: "joystick" }, { e: "🗜️", n: "clamp" }, { e: "💽", n: "minidisc" },
  { e: "💾", n: "floppy" }, { e: "💿", n: "cd" }, { e: "📀", n: "dvd" }, { e: "📼", n: "vhs" },
  { e: "📷", n: "camera" }, { e: "📸", n: "camera flash" }, { e: "📹", n: "video camera" }, { e: "🎥", n: "movie" },
  { e: "📽️", n: "film projector" }, { e: "🎞️", n: "film frames" }, { e: "📞", n: "telephone" }, { e: "☎️", n: "phone 2" },
  { e: "📟", n: "pager" }, { e: "📠", n: "fax" }, { e: "📺", n: "tv 2" }, { e: "📻", n: "radio 2" },
  { e: "🎙️", n: "studio mic" }, { e: "🎚️", n: "level slider" }, { e: "🎛️", n: "knobs" }, { e: "🧭", n: "compass" },
  { e: "⏱️", n: "stopwatch" }, { e: "⏲️", n: "timer" }, { e: "⏰", n: "alarm" }, { e: "🕰️", n: "mantelpiece clock" },
  { e: "⏳", n: "hourglass flowing" }, { e: "⌛", n: "hourglass" }, { e: "📡", n: "satellite antenna" }, { e: "🔋", n: "battery" },
  { e: "🔌", n: "plug" }, { e: "💡", n: "bulb" }, { e: "🔦", n: "flashlight" }, { e: "🕯️", n: "candle" },
  { e: "🧯", n: "extinguisher" }, { e: "🛢️", n: "oil drum" }, { e: "💸", n: "money wings" }, { e: "💵", n: "dollar" },
  { e: "💴", n: "yen" }, { e: "💶", n: "euro" }, { e: "💷", n: "pound" }, { e: "🪙", n: "coin" },
  { e: "💰", n: "money bag" }, { e: "💳", n: "credit card" }, { e: "💎", n: "gem" }, { e: "⚖️", n: "balance" },
  { e: "🧰", n: "toolbox" }, { e: "🔧", n: "wrench" }, { e: "🔨", n: "hammer" }, { e: "🛠️", n: "hammer wrench" },
  { e: "⛏️", n: "pick" }, { e: "🪓", n: "axe" }, { e: "🪚", n: "carpentry saw" }, { e: "🔩", n: "nut bolt" },
  { e: "⚙️", n: "gear" }, { e: "🧱", n: "brick" }, { e: "⛓️", n: "chains" }, { e: "🧲", n: "magnet" },
  { e: "🔫", n: "water pistol" }, { e: "💣", n: "bomb" }, { e: "🧨", n: "firecracker" }, { e: "🪓", n: "axe 2" },
  { e: "🔪", n: "knife" }, { e: "🗡️", n: "dagger" }, { e: "⚔️", n: "swords" }, { e: "🛡️", n: "shield" },
  { e: "🚬", n: "cigarette" }, { e: "⚰️", n: "coffin" }, { e: "🪦", n: "headstone" }, { e: "⚱️", n: "urn" },
  { e: "🏺", n: "amphora" }, { e: "🔮", n: "crystal ball" }, { e: "📿", n: "prayer beads" }, { e: "🧿", n: "nazar" },
  { e: "💈", n: "barber pole" }, { e: "⚗️", n: "alembic" }, { e: "🔭", n: "telescope" }, { e: "🔬", n: "microscope" },
  { e: "🕳️", n: "hole" }, { e: "🩹", n: "bandaid" }, { e: "🩺", n: "stethoscope" }, { e: "💊", n: "pill" },
  { e: "💉", n: "syringe" }, { e: "🩸", n: "blood" }, { e: "🧬", n: "dna" }, { e: "🦠", n: "microbe" },
  { e: "🧫", n: "petri dish" }, { e: "🧪", n: "test tube" }, { e: "🌡️", n: "thermometer 2" }, { e: "🧹", n: "broom" },
  { e: "🧺", n: "basket" }, { e: "🧻", n: "toilet paper" }, { e: "🚽", n: "toilet" }, { e: "🚰", n: "potable water" },
  { e: "🚿", n: "shower" }, { e: "🛁", n: "bathtub" }, { e: "🛀", n: "bath 2" }, { e: "🧼", n: "soap" },
  { e: "🪒", n: "razor" }, { e: "🧽", n: "sponge" }, { e: "🧴", n: "lotion" }, { e: "🛎️", n: "bellhop" },
  { e: "🔑", n: "key" }, { e: "🗝️", n: "old key" }, { e: "🚪", n: "door" }, { e: "🪑", n: "chair" },
  { e: "🛋️", n: "couch lamp" }, { e: "🛏️", n: "bed" }, { e: "🛌", n: "sleeping bed" }, { e: "🧸", n: "teddy" },
  { e: "🖼️", n: "framed picture" }, { e: "🛍️", n: "shopping bags" }, { e: "🛒", n: "shopping cart" }, { e: "🎁", n: "gift" },
  { e: "🎈", n: "balloon" }, { e: "🎏", n: "carp streamer" }, { e: "🎀", n: "ribbon" }, { e: "🪄", n: "magic wand" },
  { e: "🪅", n: "pinata" }, { e: "🎊", n: "confetti ball" }, { e: "🎉", n: "party popper" }, { e: "🎎", n: "dolls" },
  { e: "🏮", n: "izakaya lantern" }, { e: "🎐", n: "wind chime" }, { e: "🧧", n: "red envelope" }, { e: "✉️", n: "envelope" },
  { e: "📩", n: "envelope arrow" }, { e: "📨", n: "incoming envelope" }, { e: "📧", n: "email" }, { e: "💌", n: "love letter" },
  { e: "📥", n: "inbox" }, { e: "📤", n: "outbox" }, { e: "📦", n: "package" }, { e: "🏷️", n: "label" },
  { e: "📪", n: "closed mailbox lowered" }, { e: "📫", n: "closed mailbox raised" }, { e: "📬", n: "open mailbox raised" },
  { e: "📭", n: "open mailbox lowered" }, { e: "📮", n: "postbox" }, { e: "📜", n: "scroll" }, { e: "📃", n: "page curl" },
  { e: "📄", n: "page" }, { e: "📑", n: "bookmarks" }, { e: "🧾", n: "receipt" }, { e: "📊", n: "bar chart" },
  { e: "📈", n: "chart up" }, { e: "📉", n: "chart down" }, { e: "🗒️", n: "spiral notepad" }, { e: "🗓️", n: "spiral calendar" },
  { e: "📆", n: "tear off calendar" }, { e: "📅", n: "calendar" }, { e: "🗑️", n: "wastebasket" }, { e: "📇", n: "card index" },
  { e: "🗃️", n: "card box" }, { e: "🗳️", n: "ballot box" }, { e: "🗄️", n: "file cabinet" }, { e: "📋", n: "clipboard" },
  { e: "📁", n: "file folder" }, { e: "📂", n: "open folder" }, { e: "🗂️", n: "dividers" }, { e: "🗞️", n: "rolled newspaper" },
  { e: "📰", n: "newspaper" }, { e: "📓", n: "notebook" }, { e: "📔", n: "notebook cover" }, { e: "📒", n: "ledger" },
  { e: "📕", n: "closed book" }, { e: "📖", n: "open book" }, { e: "📗", n: "green book" }, { e: "📘", n: "blue book" },
  { e: "📙", n: "orange book" }, { e: "📚", n: "books" }, { e: "🔖", n: "bookmark" }, { e: "🧷", n: "safety pin" },
  { e: "🔗", n: "link" }, { e: "📎", n: "paperclip" }, { e: "🖇️", n: "paperclips" }, { e: "📐", n: "triangular ruler" },
  { e: "📏", n: "straight ruler" }, { e: "🧮", n: "abacus" }, { e: "📌", n: "pushpin" }, { e: "📍", n: "round pushpin" },
  { e: "✂️", n: "scissors" }, { e: "🖊️", n: "pen" }, { e: "🖋️", n: "fountain pen" }, { e: "✒️", n: "nib" },
  { e: "🖌️", n: "paintbrush" }, { e: "🖍️", n: "crayon" }, { e: "📝", n: "memo" }, { e: "✏️", n: "pencil" },
  { e: "🔍", n: "magnifier left" }, { e: "🔎", n: "magnifier right" }, { e: "🔏", n: "lock pen" }, { e: "🔐", n: "lock key" },
  { e: "🔒", n: "locked" }, { e: "🔓", n: "unlocked" },
];

// Symbols
const SYMBOLS: EmojiItem[] = [
  { e: "❤️", n: "red heart 2" }, { e: "🧡", n: "orange heart 2" }, { e: "💛", n: "yellow heart 2" }, { e: "💚", n: "green heart 2" },
  { e: "💙", n: "blue heart 2" }, { e: "💜", n: "purple heart 2" }, { e: "🖤", n: "black heart 2" }, { e: "🤍", n: "white heart 2" },
  { e: "🤎", n: "brown heart 2" }, { e: "💯", n: "hundred" }, { e: "💢", n: "anger" }, { e: "💥", n: "collision" },
  { e: "💫", n: "dizzy" }, { e: "💦", n: "sweat droplets" }, { e: "💨", n: "dash" }, { e: "🕳️", n: "hole 2" },
  { e: "💣", n: "bomb 2" }, { e: "💬", n: "speech balloon" }, { e: "👁️‍🗨️", n: "eye speech" }, { e: "🗨️", n: "left speech" },
  { e: "🗯️", n: "right anger" }, { e: "💭", n: "thought" }, { e: "💤", n: "zzz" }, { e: "✅", n: "check mark" },
  { e: "☑️", n: "check box" }, { e: "✔️", n: "heavy check" }, { e: "❌", n: "cross mark" }, { e: "❎", n: "cross mark button" },
  { e: "➕", n: "plus" }, { e: "➖", n: "minus" }, { e: "➗", n: "divide" }, { e: "✖️", n: "multiply" },
  { e: "🟰", n: "heavy equals" }, { e: "‼️", n: "double exclamation" }, { e: "⁉️", n: "exclamation question" }, { e: "❓", n: "question" },
  { e: "❔", n: "white question" }, { e: "❕", n: "white exclamation" }, { e: "❗", n: "exclamation" }, { e: "〰️", n: "wavy dash" },
  { e: "💱", n: "currency exchange" }, { e: "💲", n: "heavy dollar" }, { e: "⚠️", n: "warning" }, { e: "🚸", n: "children crossing" },
  { e: "⛔", n: "no entry" }, { e: "🚫", n: "prohibited" }, { e: "🚳", n: "no bicycles" }, { e: "🚭", n: "no smoking" },
  { e: "🚯", n: "no littering" }, { e: "🚱", n: "non potable water" }, { e: "🚷", n: "no pedestrians" }, { e: "📵", n: "no mobile phones" },
  { e: "🔞", n: "no one under 18" }, { e: "☢️", n: "radioactive" }, { e: "☣️", n: "biohazard" }, { e: "⬆️", n: "up arrow" },
  { e: "↗️", n: "up right arrow" }, { e: "➡️", n: "right arrow" }, { e: "↘️", n: "down right arrow" }, { e: "⬇️", n: "down arrow" },
  { e: "↙️", n: "down left arrow" }, { e: "⬅️", n: "left arrow" }, { e: "↖️", n: "up left arrow" }, { e: "↕️", n: "up down arrow" },
  { e: "↔️", n: "left right arrow" }, { e: "↩️", n: "right arrow curving left" }, { e: "↪️", n: "left arrow curving right" },
  { e: "⤴️", n: "right arrow curving up" }, { e: "⤵️", n: "right arrow curving down" }, { e: "🔁", n: "repeat" },
  { e: "🔂", n: "repeat one" }, { e: "🔄", n: "counterclockwise arrows" }, { e: "🔃", n: "clockwise arrows" }, { e: "🎵", n: "note 2" },
  { e: "➡️", n: "fast forward" }, { e: "⏫", n: "fast up" }, { e: "⏬", n: "fast down" }, { e: "⏪", n: "rewind" },
  { e: "⏮️", n: "previous track" }, { e: "⏭️", n: "next track" }, { e: "⏯️", n: "play pause" }, { e: "⏹️", n: "stop" },
  { e: "⏺️", n: "record" }, { e: "⏏️", n: "eject" }, { e: "🎦", n: "cinema" }, { e: "🔆", n: "dim" },
  { e: "📶", n: "antenna bars" }, { e: "📳", n: "vibration" }, { e: "📴", n: "mobile off" }, { e: "♻️", n: "recycle" },
  { e: "📛", n: "name badge" }, { e: "⚜️", n: "fleur de lis" }, { e: "🔰", n: "japanese beginner" }, { e: "⭕", n: "hollow red circle" },
  { e: "✅", n: "check 2" }, { e: "☑️", n: "check 3" }, { e: "✔️", n: "check 4" }, { e: "❌", n: "cross 2" },
  { e: "❎", n: "cross 3" }, { e: "❌", n: "x" }, { e: "⭕", n: "o" }, { e: "🆗", n: "ok button" },
  { e: "🆒", n: "cool button" }, { e: "🆕", n: "new button" }, { e: "🆙", n: "up button" }, { e: "🆓", n: "free button" },
  { e: "0️⃣", n: "0" }, { e: "1️⃣", n: "1" }, { e: "2️⃣", n: "2" }, { e: "3️⃣", n: "3" },
  { e: "4️⃣", n: "4" }, { e: "5️⃣", n: "5" }, { e: "6️⃣", n: "6" }, { e: "7️⃣", n: "7" },
  { e: "8️⃣", n: "8" }, { e: "9️⃣", n: "9" }, { e: "🔟", n: "10" }, { e: "🔢", n: "input numbers" },
  { e: "#️⃣", n: "hash" }, { e: "*️⃣", n: "asterisk" }, { e: "⏏️", n: "eject 2" }, { e: "▶️", n: "play" },
  { e: "⏸️", n: "pause" }, { e: "⏯️", n: "play pause 2" }, { e: "⏹️", n: "stop 2" }, { e: "⏺️", n: "record 2" },
  { e: "⏭️", n: "next 2" }, { e: "⏮️", n: "previous 2" }, { e: "⏩", n: "fast forward 2" }, { e: "⏪", n: "rewind 2" },
  { e: "⏫", n: "up 2" }, { e: "⏬", n: "down 2" }, { e: "🔅", n: "low brightness" }, { e: "🔆", n: "high brightness" },
  { e: "🔊", n: "loud sound" }, { e: "🔉", n: "medium sound" }, { e: "🔈", n: "speaker" }, { e: "🔇", n: "muted" },
  { e: " bell", n: "bell" }, { e: "🔕", n: "bell off" }, { e: "📣", n: "megaphone" }, { e: "📢", n: "loudspeaker" },
  { e: "👁️‍🗨️", n: "eye speech 2" }, { e: "💬", n: "speech 2" }, { e: "💭", n: "thought 2" }, { e: "🗯️", n: "anger 2" },
  { e: "♠️", n: "spade suit" }, { e: "♥️", n: "heart suit 2" }, { e: "♦️", n: "diamond suit" }, { e: "♣️", n: "club suit" },
  { e: "🃏", n: "joker" }, { e: "🀄", n: "mahjong" }, { e: "🎴", n: "flower cards" }, { e: "🎯", n: "bullseye 2" },
  { e: "🕐", n: "1 oclock" }, { e: "🕑", n: "2 oclock" }, { e: "🕒", n: "3 oclock" }, { e: "🕓", n: "4 oclock" },
  { e: "🕔", n: "5 oclock" }, { e: "🕕", n: "6 oclock" }, { e: "🕖", n: "7 oclock" }, { e: "🕗", n: "8 oclock" },
  { e: "🕘", n: "9 oclock" }, { e: "🕙", n: "10 oclock" }, { e: "🕚", n: "11 oclock" }, { e: "🕛", n: "12 oclock" },
];

// Flags
const FLAGS: EmojiItem[] = [
  { e: "🏳️", n: "white flag" }, { e: "🏴", n: "black flag" }, { e: "🏁", n: "checkered flag" },
  { e: "🚩", n: "triangular flag" }, { e: "🏳️‍🌈", n: "rainbow flag" }, { e: "🏳️‍⚧️", n: "trans flag" },
  { e: "🏴‍☠️", n: "pirate flag" }, { e: "🇺🇸", n: "usa" }, { e: "🇬🇧", n: "uk" }, { e: "🇨🇦", n: "canada" },
  { e: "🇦🇺", n: "australia" }, { e: "🇳🇿", n: "new zealand" }, { e: "🇮🇳", n: "india" }, { e: "🇧🇩", n: "bangladesh" },
  { e: "🇵🇰", n: "pakistan" }, { e: "🇱🇰", n: "sri lanka" }, { e: "🇳🇵", n: "nepal" }, { e: "🇧🇹", n: "bhutan" },
  { e: "🇲🇻", n: "maldives" }, { e: "🇨🇳", n: "china" }, { e: "🇯🇵", n: "japan" }, { e: "🇰🇷", n: "korea south" },
  { e: "🇰🇵", n: "korea north" }, { e: "🇹🇭", n: "thailand" }, { e: "🇻🇳", n: "vietnam" }, { e: "🇲🇾", n: "malaysia" },
  { e: "🇸🇬", n: "singapore" }, { e: "🇮🇩", n: "indonesia" }, { e: "🇵🇭", n: "philippines" }, { e: "🇲🇲", n: "myanmar" },
  { e: "🇰h", n: "cambodia" }, { e: "🇱🇦", n: "laos" }, { e: "🇧🇳", n: "brunei" }, { e: "🇹🇷", n: "turkey" },
  { e: "🇸🇦", n: "saudi arabia" }, { e: "🇦🇪", n: "uae" }, { e: "🇶🇦", n: "qatar" }, { e: "🇰🇼", n: "kuwait" },
  { e: "🇧🇭", n: "bahrain" }, { e: "🇴🇲", n: "oman" }, { e: "🇾🇪", n: "yemen" }, { e: "🇯🇴", n: "jordan" },
  { e: "🇮🇶", n: "iraq" }, { e: "🇮🇷", n: "iran" }, { e: "🇮🇱", n: "israel" }, { e: "🇪🇬", n: "egypt" },
  { e: "🇱🇧", n: "lebanon" }, { e: "🇸🇾", n: "syria" }, { e: "🇩🇪", n: "germany" }, { e: "🇫🇷", n: "france" },
  { e: "🇮🇹", n: "italy" }, { e: "🇪🇸", n: "spain" }, { e: "🇵🇹", n: "portugal" }, { e: "🇳🇱", n: "netherlands" },
  { e: "🇧🇪", n: "belgium" }, { e: "🇨🇭", n: "switzerland" }, { e: "🇦🇹", n: "austria" }, { e: "🇸🇪", n: "sweden" },
  { e: "🇳🇴", n: "norway" }, { e: "🇩🇰", n: "denmark" }, { e: "🇫🇮", n: "finland" }, { e: "🇮🇪", n: "ireland" },
  { e: "🇵🇱", n: "poland" }, { e: "🇷🇺", n: "russia" }, { e: "🇺🇦", n: "ukraine" }, { e: "🇬🇷", n: "greece" },
  { e: "🇧🇷", n: "brazil" }, { e: "🇦🇷", n: "argentina" }, { e: "🇲🇽", n: "mexico" }, { e: "🇨🇱", n: "chile" },
  { e: "🇨🇴", n: "colombia" }, { e: "🇵🇪", n: "peru" }, { e: "🇻🇪", n: "venezuela" }, { e: "🇿🇦", n: "south africa" },
  { e: "🇳🇬", n: "nigeria" }, { e: "🇰🇪", n: "kenya" }, { e: "🇪🇬", n: "egypt 2" }, { e: "🇲🇦", n: "morocco" },
];

interface Category {
  id: string;
  label: string;
  icon: React.ReactNode;
  emojis: EmojiItem[];
}

const CATEGORIES: Category[] = [
  { id: "smileys", label: "Smileys & Emotion", icon: <SmileIcon />, emojis: SMILEYS },
  { id: "people", label: "People & Gestures", icon: <HandIcon />, emojis: PEOPLE },
  { id: "animals", label: "Animals & Nature", icon: <CatIcon />, emojis: ANIMALS },
  { id: "food", label: "Food & Drink", icon: <CoffeeIcon />, emojis: FOOD },
  { id: "activities", label: "Activities", icon: <BallIcon />, emojis: ACTIVITIES },
  { id: "travel", label: "Travel & Places", icon: <PlaneIcon />, emojis: TRAVEL },
  { id: "objects", label: "Objects", icon: <BulbIcon />, emojis: OBJECTS },
  { id: "symbols", label: "Symbols", icon: <HeartIcon />, emojis: SYMBOLS },
  { id: "flags", label: "Flags", icon: <FlagIcon />, emojis: FLAGS },
];

// ─── Skin tones ────────────────────────────────────────────────────────────

const SKIN_TONES = [
  { id: "default", label: "Default", tone: "" },
  { id: "light", label: "Light", tone: "🏻" },
  { id: "medium-light", label: "Medium-Light", tone: "🏼" },
  { id: "medium", label: "Medium", tone: "🏽" },
  { id: "medium-dark", label: "Medium-Dark", tone: "🏾" },
  { id: "dark", label: "Dark", tone: "🏿" },
] as const;

/**
 * Apply a skin-tone modifier to a base emoji if it supports one.
 *
 * Emoji skin tones are an "emoji modifier" (U+1F3FB..U+1F3FF) appended after
 * the base emoji character. Not every emoji accepts one — only those
 * depicting a human body part or human form do. The `k: true` flag on
 * our catalog entries marks these.
 *
 * We do a simple codepoint check: emoji modifiers only stick to a base
 * emoji whose primary codepoint is in the U+1F466..U+1F9FF range
 * (Person/Body block). This catches virtually all the human-form emoji.
 * For everything else we leave the emoji alone.
 */
function applySkinTone(emoji: string, tone: string, supportsTone: boolean): string {
  if (!tone || !supportsTone) return emoji;
  // Strip an existing modifier if present (e.g. user toggled tone twice)
  const base = emoji.replace(/[\u{1F3FB}-\u{1F3FF}]/gu, "");
  return base + tone;
}

// ─── Recently used persistence ─────────────────────────────────────────────

const RECENT_KEY = "treefriend.chat.emoji.recent";
const MAX_RECENT = 32;

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x) => typeof x === "string").slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

function saveRecent(items: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(items.slice(0, MAX_RECENT)));
  } catch {
    /* ignore quota errors */
  }
}

// ─── Component ─────────────────────────────────────────────────────────────

interface EmojiPickerProps {
  /** Called every time an emoji is picked. */
  onSelect: (emoji: string) => void;
  /** Optional: render a custom trigger element. Defaults to a smile button. */
  children?: React.ReactNode;
  /** Optional: which side of the trigger to align the popover to. */
  align?: "start" | "center" | "end";
  /** Optional: open state control. If omitted, picker manages its own state. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function EmojiPicker({
  onSelect,
  children,
  align = "start",
  open: controlledOpen,
  onOpenChange,
}: EmojiPickerProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (v: boolean) => {
    setInternalOpen(v);
    onOpenChange?.(v);
  };

  const [activeCategory, setActiveCategory] = useState<string>("smileys");
  const [search, setSearch] = useState("");
  const [skinTone, setSkinTone] = useState<string>("default");
  const [recent, setRecent] = useState<string[]>([]);
  const [showSkinTonePicker, setShowSkinTonePicker] = useState(false);

  const gridRef = useRef<HTMLDivElement>(null);

  // Load recently used once on mount (client-only — localStorage)
  useEffect(() => {
    setRecent(loadRecent());
  }, []);

  // Reset search when popover closes — gives a fresh view on next open.
  useEffect(() => {
    if (!open) {
      setSearch("");
      setActiveCategory("smileys");
      setShowSkinTonePicker(false);
    }
  }, [open]);

  // Filtered emoji list based on search
  const filteredEmojis = useMemo<EmojiItem[]>(() => {
    const q = search.trim().toLowerCase();
    if (!q) {
      const cat = CATEGORIES.find((c) => c.id === activeCategory);
      return cat ? cat.emojis : [];
    }
    // Search across ALL categories
    const all = CATEGORIES.flatMap((c) => c.emojis);
    return all.filter((e) => e.n.includes(q));
  }, [search, activeCategory]);

  const recentEmojis = useMemo<EmojiItem[]>(() => {
    if (recent.length === 0) return [];
    const recentSet = new Set(recent);
    // Reuse the catalog so we keep names/skin-tone support flags
    return CATEGORIES.flatMap((c) => c.emojis).filter((e) => recentSet.has(e.e));
  }, [recent]);

  const handlePick = useCallback(
    (item: EmojiItem) => {
      const finalEmoji = applySkinTone(item.e, SKIN_TONES.find((t) => t.id === skinTone)?.tone ?? "", !!item.k);
      onSelect(finalEmoji);

      // Update recently used list (move to front, dedupe, cap at MAX_RECENT)
      setRecent((prev) => {
        const next = [item.e, ...prev.filter((x) => x !== item.e)].slice(0, MAX_RECENT);
        saveRecent(next);
        return next;
      });
    },
    [onSelect, skinTone],
  );

  const isSearching = search.trim().length > 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {children ?? (
          <button
            type="button"
            className="p-2 rounded-full hover:bg-muted/50 transition-colors shrink-0 text-muted-foreground hover:text-foreground"
            aria-label="Open emoji picker"
          >
            <Smile className="w-5 h-5" />
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align={align}
        side="top"
        sideOffset={8}
        className="w-[min(92vw,360px)] p-0 rounded-2xl border border-border bg-popover shadow-xl"
        // Prevent clicks inside the picker from blurring the textarea
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex flex-col max-h-[420px]">
          {/* ─── Search ──────────────────────────────────────────────── */}
          <div className="p-3 border-b border-border">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search emoji..."
                className="w-full text-sm bg-muted/40 rounded-lg pl-8 pr-7 py-2 border border-transparent focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/40 placeholder:text-muted-foreground"
                autoFocus
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-muted/80 text-muted-foreground hover:text-foreground"
                  aria-label="Clear search"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* ─── Recent row (only when not searching and have recents) ── */}
          {!isSearching && recentEmojis.length > 0 && (
            <div className="p-3 border-b border-border">
              <div className="flex items-center gap-1.5 mb-2 text-[11px] font-medium text-muted-foreground">
                <Clock className="w-3 h-3" />
                Recently used
              </div>
              <div className="grid grid-cols-8 gap-0.5">
                {recentEmojis.slice(0, 16).map((item) => (
                  <button
                    key={`recent-${item.e}`}
                    type="button"
                    onClick={() => handlePick(item)}
                    className="aspect-square text-xl leading-none rounded hover:bg-accent/15 transition-colors flex items-center justify-center"
                    title={item.n}
                    aria-label={item.n}
                  >
                    {item.e}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ─── Emoji grid ──────────────────────────────────────────── */}
          <div
            ref={gridRef}
            className="flex-1 overflow-y-auto p-3 min-h-[200px]"
          >
            {filteredEmojis.length === 0 ? (
              <div className="text-center text-sm text-muted-foreground py-8">
                No emoji found
              </div>
            ) : (
              <div className="grid grid-cols-8 gap-0.5">
                {filteredEmojis.map((item, idx) => (
                  <button
                    key={`${item.e}-${idx}`}
                    type="button"
                    onClick={() => handlePick(item)}
                    className="aspect-square text-xl leading-none rounded hover:bg-accent/15 hover:scale-110 active:scale-95 transition-transform flex items-center justify-center"
                    title={item.n}
                    aria-label={item.n}
                  >
                    {applySkinTone(item.e, SKIN_TONES.find((t) => t.id === skinTone)?.tone ?? "", !!item.k)}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* ─── Category bar + skin-tone selector ──────────────────── */}
          {!isSearching && (
            <div className="border-t border-border px-2 py-1.5 flex items-center justify-between gap-1 bg-muted/20 rounded-b-2xl">
              <div className="flex items-center gap-0.5 overflow-x-auto no-scrollbar">
                {/* Recent tab (clock) */}
                <button
                  type="button"
                  onClick={() => {
                    setSearch("");
                    setActiveCategory("smileys");
                  }}
                  className={cn(
                    "p-1.5 rounded-md shrink-0 transition-colors",
                    activeCategory === "smileys" && !search
                      ? "bg-accent/20 text-accent"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted",
                  )}
                  aria-label="Smileys"
                  title="Smileys"
                >
                  <Smile className="w-4 h-4" />
                </button>
                {CATEGORIES.slice(1).map((cat) => (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => {
                      setSearch("");
                      setActiveCategory(cat.id);
                    }}
                    className={cn(
                      "p-1.5 rounded-md shrink-0 transition-colors",
                      activeCategory === cat.id
                        ? "bg-accent/20 text-accent"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted",
                    )}
                    aria-label={cat.label}
                    title={cat.label}
                  >
                    <span className="block w-4 h-4">{cat.icon}</span>
                  </button>
                ))}
              </div>

              {/* Skin tone picker */}
              <div className="relative shrink-0">
                <button
                  type="button"
                  onClick={() => setShowSkinTonePicker((v) => !v)}
                  className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                  aria-label="Choose skin tone"
                  title="Skin tone"
                >
                  <span className="block w-4 h-4 rounded-full border border-current relative overflow-hidden">
                    <span
                      className="absolute inset-0"
                      style={{
                        background:
                          skinTone === "default"
                            ? "linear-gradient(135deg,#ffdfb4 0%,#f1c27d 25%,#c68642 50%,#8d5524 75%,#3b1d11 100%)"
                            : skinTone === "light"
                            ? "#ffdfb4"
                            : skinTone === "medium-light"
                            ? "#f1c27d"
                            : skinTone === "medium"
                            ? "#c68642"
                            : skinTone === "medium-dark"
                            ? "#8d5524"
                            : "#3b1d11",
                      }}
                    />
                  </span>
                </button>
                {showSkinTonePicker && (
                  <div className="absolute bottom-full right-0 mb-1 p-1 bg-popover border border-border rounded-lg shadow-lg flex items-center gap-0.5 z-10">
                    {SKIN_TONES.map((tone) => (
                      <button
                        key={tone.id}
                        type="button"
                        onClick={() => {
                          setSkinTone(tone.id);
                          setShowSkinTonePicker(false);
                        }}
                        className={cn(
                          "w-5 h-5 rounded-full border-2 transition-transform hover:scale-110",
                          skinTone === tone.id ? "border-accent" : "border-transparent",
                        )}
                        style={{
                          background:
                            tone.id === "default"
                              ? "linear-gradient(135deg,#ffdfb4 0%,#f1c27d 25%,#c68642 50%,#8d5524 75%,#3b1d11 100%)"
                              : tone.tone
                                ? toneToColor(tone.tone)
                                : undefined,
                        }}
                        aria-label={tone.label}
                        title={tone.label}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function toneToColor(tone: string): string {
  switch (tone) {
    case "🏻": return "#ffdfb4";
    case "🏼": return "#f1c27d";
    case "🏽": return "#c68642";
    case "🏾": return "#8d5524";
    case "🏿": return "#3b1d11";
    default: return "#f1c27d";
  }
}
