-- gpt-6.2-sol 纳入已核实推理模型。只补空值，不改跟随、不停用、不覆盖已经写上的思考程度。
-- 留空的显式行写成 medium，与其它已核实模型相同；不会写成 high。

UPDATE model_assignments
SET reasoning_effort = 'medium'
WHERE reasoning_effort IS NULL
  AND disabled = 0
  AND follow IS NULL
  AND consumer <> 'embedding'
  AND (
    model = 'gpt-6.2-sol'
    OR (
      instr(model, '/') > 0
      AND instr(substr(model, instr(model, '/') + 1), '/') = 0
      AND substr(model, instr(model, '/') + 1) = 'gpt-6.2-sol'
    )
  );
