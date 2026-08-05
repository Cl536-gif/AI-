const { detectFormatViolations } = require('../../services/formatGuard');

function main() {
  const unsafe =
    '选一份小炒肉（大概一掌大小的量，也就是三四片肉），没有就换成宫保鸡丁，热量和营养结构接近。';
  const types = detectFormatViolations(unsafe).map((item) => item.type);
  if (!types.includes('unsupported_nutrition_equivalence')) {
    throw new Error('没有拦截仅凭菜名断言热量和营养结构接近');
  }
  if (!types.includes('inconsistent_portion_equivalence')) {
    throw new Error('没有拦截一掌直接换算固定片数');
  }

  const fixedPieces = detectFormatViolations('小炒肉挑瘦一点，吃三四块就够了。').map((item) => item.type);
  if (!fixedPieces.includes('fixed_piece_count_for_mixed_dish')) {
    throw new Error('没有拦截混合炒菜固定吃几块的武断分量');
  }

  const safe = '选一份大概一掌大小的小炒肉；没有就换成一份鸡肉炒菜，具体用油和分量要看窗口实际情况。';
  const safeTypes = detectFormatViolations(safe).map((item) => item.type);
  if (safeTypes.includes('unsupported_nutrition_equivalence') || safeTypes.includes('inconsistent_portion_equivalence')) {
    throw new Error(`安全表达被误拦截: ${safeTypes.join(',')}`);
  }

  console.log('✅ 禁止仅凭菜名断言替代菜热量或营养结构接近');
  console.log('✅ 禁止把一掌大小直接换算成固定片数或块数');
  console.log('✅ 禁止给大小不固定的混合炒菜规定固定片数');
  console.log('✅ 保留合理的生活化分量和差异说明');
}

try {
  main();
} catch (err) {
  console.error(`❌ 测试失败: ${err.message}`);
  process.exit(1);
}
