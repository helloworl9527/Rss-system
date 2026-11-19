-- 模型分配的思考程度（reasoning_effort）。与 strictness（结构化输出）无关。
-- NULL：跟随上游；显式分配的已核实推理模型在解析时仍会请求 medium，保存时会写成 medium。
-- 已有的显式行若模型已核实，直接写成 medium，使库里的值与请求一致。

ALTER TABLE model_assignments ADD COLUMN reasoning_effort TEXT
  CHECK (reasoning_effort IS NULL OR reasoning_effort IN ('none','minimal','low','medium','high','xhigh','max'));

UPDATE model_assignments
SET reasoning_effort = 'medium'
WHERE reasoning_effort IS NULL
  AND disabled = 0
  AND follow IS NULL
  AND (
    model IN ('gpt-6.1-terra','gpt-6-astra','gpt-6.1-sol','gpt-6-sol','gpt-6-luna','gpt-5','gpt-5-2025-08-07')
    OR (
      instr(model, '/') > 0
      AND instr(substr(model, instr(model, '/') + 1), '/') = 0
      AND substr(model, instr(model, '/') + 1) IN ('gpt-6.1-terra','gpt-6-astra','gpt-6.1-sol','gpt-6-sol','gpt-6-luna','gpt-5','gpt-5-2025-08-07')
    )
  );
