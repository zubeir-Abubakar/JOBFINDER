"use client";

import { skillLevelLabel, type SkillLevel } from "@/lib/profile-options";
import type { Skill } from "@/lib/profile";
import { addSkillAction, saveSkillLevelsAction } from "@/lib/actions/profile";
import { SubmitButton } from "./SubmitButton";
import { Icon } from "./icons";

const LEVELS: SkillLevel[] = ["expert", "advanced", "working", "exposure", "unspecified"];
const CATEGORIES = ["Automation & testing", "Programming", "DevOps & infrastructure", "Performance & monitoring", "QA management", "From CV", "Other"];

/**
 * One flat skills list: the name is read from your profile and the level is
 * selected beside it. A single save updates every changed level. The add row
 * stays at the bottom as the only separate skills form.
 */
export function SkillsEditor({ skills }: { skills: Skill[] }) {
  return (
    <div className="skills-editor">
      {skills.length === 0 ? (
        <div className="empty" style={{ padding: "18px 12px" }}>
          <strong>No CV skills yet</strong>
          Upload or import your CV, or add a skill at the bottom of this section.
        </div>
      ) : (
        <form action={saveSkillLevelsAction} className="skill-level-form">
          <div className="skill-rows" aria-label="Skills and proficiency levels">
            {skills.map((skill) => (
              <div key={skill.id} className="skill-row">
                <input type="hidden" name="skill_id" value={skill.id} />
                <span className="skill-name" title={skill.name}>{skill.name}</span>
                <select
                  name="level"
                  className="select skill-level-select"
                  defaultValue={skill.level}
                  aria-label={`Proficiency for ${skill.name}`}
                >
                  {LEVELS.map((level) => <option key={level} value={level}>{skillLevelLabel(level)}</option>)}
                </select>
                <SubmitButton
                  className="btn btn-sm btn-danger skill-remove"
                  name="intent"
                  value={`delete:${skill.id}`}
                  confirm={`Remove ${skill.name} from your skills?`}
                >
                  ×
                </SubmitButton>
              </div>
            ))}
          </div>
          <div className="skill-save-row">
            <span className="hint">Names come from your CV. Choose the level you can honestly evidence, then save.</span>
            <SubmitButton className="btn btn-primary btn-sm" pendingLabel="Saving…">Save skill levels</SubmitButton>
          </div>
        </form>
      )}

      <form action={addSkillAction} className="skill-add-row">
        <div>
          <label className="label" htmlFor="skill_name">Add a skill</label>
          <input id="skill_name" name="name" className="input" placeholder="e.g. Maestro" required />
        </div>
        <div>
          <label className="label" htmlFor="skill_category">Category</label>
          <select id="skill_category" name="category" className="select" defaultValue="Automation & testing">
            {CATEGORIES.map((category) => <option key={category}>{category}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="skill_level">Level</label>
          <select id="skill_level" name="level" className="select" defaultValue="unspecified">
            {LEVELS.map((level) => <option key={level} value={level}>{skillLevelLabel(level)}</option>)}
          </select>
        </div>
        <div className="flex items-end">
          <SubmitButton className="btn btn-primary" pendingLabel="Adding…"><Icon name="plus" size={12} /> Add skill</SubmitButton>
        </div>
      </form>
    </div>
  );
}
