// 常见就餐菜品识别种子库。
//
// 作用只限于：识别用户说的是一道具体菜，并为后续追问提供菜品类别、
// 常见口味和烹饪方式线索。它不是营养数据库，也不能用菜名直接推算精确
// 热量。相同菜名在不同食堂和餐厅的用油、分量、配方差异很大，涉及营养
// 计算时仍需用户提供实际分量、图片或商家营养数据。

const DISH_GROUPS = {
  cafeteriaMeat: [
    '小炒肉', '农家小炒肉', '辣椒炒肉', '青椒肉丝', '鱼香肉丝', '京酱肉丝',
    '蒜薹肉丝', '芹菜肉丝', '木须肉', '回锅肉', '红烧肉', '粉蒸肉', '盐煎肉',
    '宫保鸡丁', '辣子鸡', '香辣鸡丁', '黄焖鸡', '大盘鸡', '可乐鸡翅',
    '香菇滑鸡', '红烧鸡块', '口水鸡', '白切鸡', '糖醋里脊', '糖醋排骨',
    '菠萝咕咾肉', '土豆烧牛肉', '番茄牛腩', '萝卜炖牛腩', '水煮肉片',
    '酸菜鱼', '水煮鱼', '红烧鱼块', '清蒸鱼', '剁椒鱼头', '冬瓜虾仁',
    '清炒虾仁', '西红柿炒鸡蛋', '番茄炒蛋', '黄瓜炒蛋', '木耳炒鸡蛋',
    '肉末蒸蛋', '蒸鸡蛋羹', '锅包肉',
  ],
  cafeteriaVegetable: [
    '麻婆豆腐', '家常豆腐', '红烧豆腐', '香煎豆腐', '酸辣土豆丝',
    '青椒土豆丝', '干锅土豆片', '地三鲜', '鱼香茄子', '肉末茄子',
    '手撕包菜', '炝炒包菜', '醋溜白菜', '上汤娃娃菜', '干锅花菜',
    '干煸豆角', '蒜蓉西兰花', '蚝油生菜', '清炒油麦菜', '香菇油菜',
    '木耳山药', '荷塘小炒', '清炒时蔬', '蒜蓉时蔬', '炒豆芽', '芹菜腐竹',
  ],
  staplesAndBreakfast: [
    '米饭', '杂粮饭', '糙米饭', '炒饭', '蛋炒饭', '盖浇饭', '煲仔饭',
    '烤肉饭', '木桶饭', '猪脚饭', '粥', '小米粥', '豆浆', '油条', '包子',
    '馒头', '花卷', '鸡蛋饼', '煎饼果子', '手抓饼', '三明治', '饭团',
    '水饺', '馄饨', '烧卖', '小笼包',
  ],
  noodlesAndBowls: [
    '兰州拉面', '牛肉面', '重庆小面', '热干面', '刀削面', '炸酱面',
    '葱油拌面', '炒面', '炒河粉', '米线', '过桥米线', '酸辣粉', '螺蛳粉',
    '麻辣烫', '麻辣拌', '麻辣香锅', '冒菜', '砂锅', '石锅拌饭', '土豆粉', '温州米线',
  ],
  takeawayCommon: [
    '黄焖鸡米饭', '隆江猪脚饭', '卤肉饭', '鸡公煲', '酸菜鱼米饭',
    '烤鱼', '烧烤', '炸串', '炸鸡', '汉堡', '披萨', '轻食沙拉', '鸡胸肉沙拉',
    '寿司', '韩式拌饭', '咖喱饭', '牛肉饭', '鸡排饭', '鸭腿饭',
  ],
  chainMcDonalds: [
    '巨无霸', '麦辣鸡腿堡', '板烧鸡腿堡', '双层吉士汉堡', '麦香鸡',
    '麦香鱼', '麦乐鸡', '麦麦脆汁鸡', '薯条', '麦满分',
  ],
  chainKfc: [
    '香辣鸡腿堡', '新奥尔良烤鸡腿堡', '老北京鸡肉卷', '吮指原味鸡',
    '新奥尔良烤翅', '香辣鸡翅', '劲爆鸡米花', '葡式蛋挞', '皮蛋瘦肉粥',
  ],
  chainChineseFastFood: [
    '吉野家牛肉饭', '吉野家鸡肉饭', '真功夫蒸饭', '真功夫排骨饭',
    '真功夫香汁排骨', '乡村基功夫鸡腿饭', '老乡鸡肥西老母鸡汤',
  ],
};

const DISH_PROFILES = [
  {
    canonicalName: '锅包肉',
    aliases: ['老式锅包肉'],
    contexts: ['cafeteria', 'takeaway', 'restaurant'],
    category: '猪肉炸制菜',
    tasteTags: ['酸甜'],
    cookingTags: ['炸', '裹汁'],
    tasteInference: { value: '酸甜', confidence: 'confirm_required' },
  },
  {
    canonicalName: '小炒肉',
    aliases: ['农家小炒肉', '辣椒炒肉', '湖南小炒肉', '湘西小炒肉'],
    contexts: ['cafeteria', 'takeaway', 'restaurant'],
    category: '猪肉炒菜',
    tasteTags: ['咸香', '偏辣'],
    cookingTags: ['炒'],
    // 不同店可能做成微辣或不辣，因此只允许提问确认，不得直接落档。
    tasteInference: { value: '偏辣', confidence: 'confirm_required' },
  },
  {
    canonicalName: '麻婆豆腐',
    aliases: [],
    contexts: ['cafeteria', 'takeaway', 'restaurant'],
    category: '豆制品',
    tasteTags: ['麻辣', '咸香'],
    cookingTags: ['烧'],
    tasteInference: { value: '麻辣', confidence: 'confirm_required' },
  },
  {
    canonicalName: '酸辣土豆丝',
    aliases: [],
    contexts: ['cafeteria', 'takeaway', 'restaurant'],
    category: '蔬菜',
    tasteTags: ['酸辣'],
    cookingTags: ['炒'],
    tasteInference: { value: '酸辣', confidence: 'confirm_required' },
  },
  {
    canonicalName: '水煮肉片',
    aliases: [],
    contexts: ['cafeteria', 'takeaway', 'restaurant'],
    category: '猪肉菜',
    tasteTags: ['麻辣'],
    cookingTags: ['水煮'],
    tasteInference: { value: '麻辣', confidence: 'confirm_required' },
  },
  {
    canonicalName: '辣子鸡',
    aliases: ['重庆辣子鸡'],
    contexts: ['cafeteria', 'takeaway', 'restaurant'],
    category: '鸡肉菜',
    tasteTags: ['香辣'],
    cookingTags: ['炒', '炸'],
    tasteInference: { value: '香辣', confidence: 'confirm_required' },
  },
];

const ALL_DISH_NAMES = new Set(Object.values(DISH_GROUPS).flat());
const PROFILE_BY_ALIAS = new Map();
DISH_PROFILES.forEach((profile) => {
  [profile.canonicalName, ...profile.aliases].forEach((name) => PROFILE_BY_ALIAS.set(name, profile));
});

function cleanDishAnswer(text) {
  return String(text || '')
    .replace(/^(我)?(喜欢|爱吃|想吃|常吃|经常吃|一般吃|就吃)/, '')
    .replace(/[，,。！？!?；;：:～~\s]+$/g, '')
    .trim();
}

function recognizeDish(text) {
  const dishName = cleanDishAnswer(text);
  if (!dishName || dishName.length > 20) return null;
  const profile = PROFILE_BY_ALIAS.get(dishName);
  if (profile) return { dishName, ...profile };
  if (ALL_DISH_NAMES.has(dishName)) {
    return {
      dishName,
      canonicalName: dishName,
      aliases: [],
      contexts: [],
      category: null,
      tasteTags: [],
      cookingTags: [],
      tasteInference: null,
    };
  }
  return null;
}

module.exports = { DISH_GROUPS, DISH_PROFILES, recognizeDish };
