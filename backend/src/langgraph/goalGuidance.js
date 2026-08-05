const MUSCLE_GOAL_REGEX = /(增肌|长肌肉|吃出肌肉|薄肌|马甲线|腹肌|肌肉线条|线条感|紧致|力量感|翘臀|练臀|直角肩)/;

const MUSCLE_GOAL_GUIDANCE =
  '这个目标需要饮食和运动一起配合，不能只靠调整饮食直接“吃出”肌肉或马甲线。' +
  '饮食主要帮助支持训练、恢复和体脂管理；后续如果你有力量训练、跑步或其他运动，记得主动告诉我运动类型、时长和大致强度。' +
  '现阶段运动消耗或手表记录只支持手动打字告诉我，比如“练了40分钟腿，手表显示消耗300千卡”，我会把设备数字作为参考，' +
  '结合实际运动和身体状态调整饮食，不会直接按手表数字等量补回；后续版本再逐步支持更方便的记录方式。';

function isMuscleDefinitionGoal(goalValue) {
  return MUSCLE_GOAL_REGEX.test(String(goalValue || ''));
}

function getUndeliveredMuscleGoalGuidance(state) {
  if (state.muscleGoalGuidanceDelivered) return null;
  const goalValue = state.slots?.goal?.confirmed ? state.slots.goal.value : null;
  return isMuscleDefinitionGoal(goalValue) ? MUSCLE_GOAL_GUIDANCE : null;
}

module.exports = {
  MUSCLE_GOAL_GUIDANCE,
  isMuscleDefinitionGoal,
  getUndeliveredMuscleGoalGuidance,
};
