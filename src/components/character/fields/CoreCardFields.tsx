import { Input, TextArea } from '../../ui';
import { AIHelperButton } from '../AIHelperButton';
import { HelpTip } from '../../ui';
import type { CharacterFieldsSnapshot } from '../../../utils/aiCharacterHelper';
import { AlternateGreetingsEditor } from '../AlternateGreetingsEditor';

/** Shared by CharacterCreation, CharacterEdit, and the interview wizard's
 *  review step — the two callers differ only in what shows up next to each
 *  label (an AI helper in Creation/Interview, a static HelpTip in Edit),
 *  everything else here was byte-identical between CharacterCreation.tsx
 *  and CharacterEdit.tsx. */
export interface AIHelperConfig {
  /** Full 6-field snapshot — "suggest" reads every OTHER field as context,
   *  so every field's button needs the whole thing, not just its own value. */
  fields: CharacterFieldsSnapshot;
  onResult: (field: keyof CharacterFieldsSnapshot) => (value: string) => void;
}

export interface CoreCardFormData {
  name: string;
  description: string;
  personality: string;
  firstMessage: string;
  scenario: string;
}

export type FieldChangeHandler = (
  field: string
) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;

export interface CoreCardFieldsProps {
  formData: CoreCardFormData;
  onChange: FieldChangeHandler;
  alternateGreetings: string[];
  onAlternateGreetingsChange: (greetings: string[]) => void;
  /** AI-helper mode (Creation, interview review). Omit for HelpTip mode. */
  aiHelper?: AIHelperConfig;
  /** HelpTip mode (Edit). Ignored when `aiHelper` is set. */
  helpTips?: {
    description?: string;
    personality?: string;
    firstMessage?: string;
    scenario?: string;
  };
}

function labelExtraFor(
  field: keyof CharacterFieldsSnapshot,
  aiHelper: AIHelperConfig | undefined,
  tip: string | undefined
) {
  if (aiHelper) {
    return <AIHelperButton field={field} fields={aiHelper.fields} onResult={aiHelper.onResult(field)} />;
  }
  return tip ? <HelpTip tip={tip} /> : undefined;
}

export function CoreCardFields({
  formData,
  onChange,
  alternateGreetings,
  onAlternateGreetingsChange,
  aiHelper,
  helpTips,
}: CoreCardFieldsProps) {
  return (
    <>
      {/* Name - Required */}
      <Input
        label="Name *"
        placeholder="Character's name"
        value={formData.name}
        onChange={onChange('name')}
        required
        autoFocus
      />

      {/* Description */}
      <TextArea
        label="Description"
        labelExtra={labelExtraFor('description', aiHelper, helpTips?.description)}
        placeholder="Describe the character's appearance, background, and other details..."
        value={formData.description}
        onChange={onChange('description')}
        rows={3}
      />

      {/* Personality */}
      <TextArea
        label="Personality"
        labelExtra={labelExtraFor('personality', aiHelper, helpTips?.personality)}
        placeholder="Character's personality traits, mannerisms, speech patterns..."
        value={formData.personality}
        onChange={onChange('personality')}
        rows={3}
      />

      {/* First Message */}
      <TextArea
        label="First Message"
        labelExtra={labelExtraFor('firstMessage', aiHelper, helpTips?.firstMessage)}
        placeholder="The character's opening message when starting a new chat..."
        value={formData.firstMessage}
        onChange={onChange('firstMessage')}
        rows={4}
      />

      {/* Alternate Greetings */}
      <AlternateGreetingsEditor greetings={alternateGreetings} onChange={onAlternateGreetingsChange} />

      {/* Scenario */}
      <TextArea
        label="Scenario"
        labelExtra={labelExtraFor('scenario', aiHelper, helpTips?.scenario)}
        placeholder="The setting or context for conversations..."
        value={formData.scenario}
        onChange={onChange('scenario')}
        rows={2}
      />
    </>
  );
}
