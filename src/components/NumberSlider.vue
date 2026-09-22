<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    label: string
    modelValue: number
    min: number
    max: number
    step?: number
    unit?: string
    decimals?: number
  }>(),
  { step: 1, unit: '', decimals: 0 }
)

const emit = defineEmits<{
  (e: 'update:modelValue', v: number): void
}>()

const display = computed(() => {
  const n = Number(props.modelValue)
  return props.decimals > 0 ? n.toFixed(props.decimals) : String(Math.round(n))
})
</script>

<template>
  <div class="field">
    <label>{{ label }}</label>
    <input
      type="range"
      :min="min"
      :max="max"
      :step="step"
      :value="modelValue"
      @input="emit('update:modelValue', Number(($event.target as HTMLInputElement).value))"
    />
    <span class="val">{{ display }}{{ unit }}</span>
  </div>
</template>
