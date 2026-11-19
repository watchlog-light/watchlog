// SPDX-License-Identifier: AGPL-3.0-only
// The words "Suggest a strong password" picks from: 1,024 everyday nouns, written for
// WatchLog (no outside list). Exactly 2^10, so one random number picks one word with no bias,
// and four words are 40 bits: about a million million passwords.
export const PASSWORD_WORDS: readonly string[] = `
  acorn actor adobe agent album alarm alley almond alpine amber anchor angle ankle antler anvil
  apple apron arbor arch arena arrow artist ash aspen atlas attic aunt autumn avenue axis badge
  bagel baker balcony ball bamboo banana band banjo bank barley barn basil basin basket bath bay
  beach beacon bead beam bean bear beaver bed bee beet bell belt bench berry bike birch bird
  biscuit blanket blaze bloom blouse boat bolt bonnet book boot border bottle boulder bowl box
  branch brass bread breeze brick bridge brook broom brush bubble bucket buckle buffalo bugle bulb
  bundle bunny burrow bus bush butter button cabin cable cactus cake calf camel camera camp canal
  candle canoe canvas canyon cape captain car caramel card cargo carpet carrot cart castle cat
  cave cedar celery cellar chain chair chalk channel chapel cheese cherry chest chimney chin
  chisel cider cinema circle citrus city clam clay cliff clock cloud clover coach coast cobalt
  cocoa coconut coffee coin collar column comet compass cone cook copper coral cork corn corner
  cottage cotton couch cousin cove cow crab cradle crane crayon cream creek crest cricket crop
  crow crown crumb crystal cube cup curtain cushion cycle daisy dance dawn deck deer delta denim
  desert desk dew dial diamond diner dish dock doctor dog dolphin dome donkey door dough dove
  dragon drawer dream dress drift drum duck dune dusk eagle ear earth easel echo eel egg elbow
  elder elk elm ember emerald engine envelope evening fabric fable falcon fan farm feather fence
  fern ferry fiddle field fig finch finger fir fire fish flag flame flask fleet flint floor flour
  flower flute foam fog forest fork fossil fountain fox frame freckle friend frog frost fruit
  funnel galaxy gallery garden garlic gate gem geyser ginger giraffe glacier glass globe glove
  goat gold goose gown grain granite grape grass gravel grove guitar gull gust hall hammer hammock
  hamster hand harbor hare harp harvest hat hawk hay hazel heart heath hedge helmet hen herb heron
  hill hinge hive honey hood hook horizon horn horse house hut ice igloo inch ink inlet iris iron
  island ivory ivy jacket jade jam jar jasmine jay jeans jelly jewel jigsaw journal judge jug
  juice jungle juniper kayak kettle key kid king kitchen kite kitten kiwi knee knot koala label
  lace ladder lagoon lake lamb lamp lane lantern larch lark laurel lava lawn leaf ledge lemon lens
  letter lettuce library lichen lid light lilac lily lime linen lion lizard llama lobster lock
  loft log loom lotus lunch lynx magnet magpie mango manor mantle map maple marble march market
  marsh mask mast mat meadow melon mesa metal meteor mill mint mirror mist mitten moat mole monkey
  moon moose morning moss moth motor mountain mouse mug mule museum mustard nail napkin nectar
  needle nest net nickel night noodle north nose note nut oak oar oasis oat ocean octave olive
  onion opal orange orbit orchard orchid organ osprey otter oval oven owl oyster paddle page pail
  paint palace palm pan pancake panda pansy paper parade park parrot parsley pasta pastry patch
  path patio paw pea peach peak pear pearl pebble pecan pedal pelican pen pencil penguin pepper
  perch petal piano picnic pier pigeon pillow pilot pine pipe pitcher plain planet plank plate
  plaza plum pocket poem pond pony pool poplar poppy porch port post pot potato pouch prairie
  puddle puffin pulley pump pumpkin puppy purse puzzle quail quarry quartz queen quill quilt
  rabbit raccoon radio raft rail rain raisin ramp ranch raven reed reef ribbon rice ridge ring
  river road robin rock rocket roof room root rope rose rudder rug ruler saddle sage sail salad
  salmon salt sand sandal satin sauce saw scarf school scooter sea seal seed shade shark shawl
  sheep shelf shell shield ship shirt shoe shore shovel shrub silk silver sink skate sketch ski
  sky slate sled sleeve slipper slope snail snow soap sock sofa soil sparrow spice spider spinach
  spire sponge spoon spring spruce square squash squid stable stage stair stamp star station steam
  steel stem step stone stool storm stove straw stream street string studio sugar suit summer sun
  sunset swan sweater swing table tablet tail tailor tangle tape tea teacup tent terrace thimble
  thistle thread thumb thunder ticket tide tiger tile timber toad toast toe tomato tool tooth
  torch tower town toy track tractor trail train tray tree trellis trout truck trumpet trunk tub
  tulip tuna tunnel turkey turnip turtle twig umbrella uncle valley van vase velvet vessel vest
  village vine vinegar violet violin visor voyage wagon waffle wall walnut walrus water wave wax
  weasel weaver well west whale wheat wheel whistle willow wind window wing winter wire wolf wood
  wool wren yacht yard yarn yogurt zebra zinc zipper abbey accent acre adder agate aisle alder
  almanac amulet anemone apricot armor arrowroot aster atrium auburn avocado awning azure badger
  ballad balsam banner barge bark barrel bayou beetle bellows beret birchbark bison blossom bluff
  bobcat bog bonsai boulevard bramble brine bronze buckwheat bunting buoy burlap buttercup cabinet
  calico candy canopy caper caravan cardinal carol cashew cask cavern chamois charcoal chestnut
  chickpea chive cinnamon citron clarinet cloak cobble cocoon comma condor copse cornet cosmos
  courtyard crater crescent crocus cupola currant cypress dahlia damson dandelion date dinghy
  dormouse drizzle duckling dumpling eggplant elmwood ermine estuary fawn fennel ferret fjord
  flannel flax flora foothill foxglove fresco gable garnet gazebo gecko glade glen gondola gopher
  gourd grotto guava gully harbour hazelnut heather hemlock hickory hollow hornet hyacinth indigo
  isle jackal jasper jetty kelp kernel kestrel kiln knoll lacquer ladle lavender leek lentil
  limestone locust lodge lupine lute mackerel mahogany mallard mandolin maraca marigold marina
  marmot mason meerkat millet minnow mistral molasses mollusk mosaic mulberry muffin mussel myrtle
  narwhal nectarine newt nook nutmeg oatmeal obsidian ocelot okra oleander onyx oriole oxbow
  pagoda papaya paprika parka parsnip peacock pergola pewter pheasant pillar pinecone pistachio
  plover polka pomelo porcupine primrose quince radish rampart raspberry redwood rhubarb rivulet
  rosemary rowan russet saffron sapling sardine savanna scallop schooner sequoia shallot shamrock
  shingle sorrel starling steeple sundial sycamore tamarind tangerine tapestry teak tern thicket
  thrush thyme topaz tortoise truffle tundra turquoise tweed vanilla veranda vineyard viola
  walkway wallaby wharf wicker wigwam windmill wisteria woodland yam
`
  .trim()
  .split(/\s+/);
