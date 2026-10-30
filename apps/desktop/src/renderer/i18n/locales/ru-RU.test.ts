import { describe, expect, it } from 'vitest';
import { createInstance } from 'i18next';
import enUS from './en-US';
import ruRU from './ru-RU';
function strings(o: Record<string, unknown>, prefix=''): Record<string,string> {
 const rows:Record<string,string>={};
 for(const[k,v]of Object.entries(o)) {
  if(typeof v==='string')rows[prefix+k]=v;
  else Object.assign(rows,strings(v as Record<string,unknown>,prefix+k+'.'));
 }
 return rows;
}
const en=strings(enUS),ru=strings(ruRU);
describe('Russian interface package',()=>{
 it('retains Russian messages and resolves new upstream messages through the declared English fallback',async()=>{
  for(const [key,text] of Object.entries(ru))expect(text.trim(),key).toBeTruthy();
  const i18n=createInstance();await i18n.init({lng:'ru-RU',fallbackLng:'en-US',resources:{'ru-RU':{translation:ruRU},'en-US':{translation:enUS}}});
  for(const key of Object.keys(en))expect(i18n.exists(key),key).toBe(true);
  expect(i18n.t('hardware.cpu')).toBe('Процессор');
  expect(i18n.t('hardware.preferred_decode_device')).toContain('Устройство декодирования');
 });
 it('preserves interpolation, rich-text tags and nested translation references',()=>{
  const tokens=(s:string)=>s.match(/\{\{.*?\}\}|<\/?[\w]+>|\$t\([^)]*\)/g)?.sort()||[];
  for(const[key,text]of Object.entries(en))if(ru[key]!==undefined)expect(tokens(ru[key]!),key).toEqual(tokens(text));
 });
 it('resolves Russian aliases and Russian singular, few and many plurals',async()=>{
  const i18n=createInstance();await i18n.init({lng:'ru',fallbackLng:'en-US',resources:{ru:{translation:ruRU},'ru-RU':{translation:ruRU},'en-US':{translation:enUS}}});
  expect(i18n.t('startup.time_minutes_ago',{count:1})).toBe('1 минуту назад');
  expect(i18n.t('startup.time_minutes_ago',{count:2})).toBe('2 минуты назад');
  expect(i18n.t('startup.time_minutes_ago',{count:5})).toBe('5 минут назад');
  expect(i18n.t('startup.time_minutes_ago',{count:21})).toBe('21 минуту назад');
  await i18n.changeLanguage('ru-RU');expect(i18n.t('menu.file')).toBe('Файл');
  expect(i18n.t('export_dialog.title')).toBe('Настройки экспорта');
 });
 it('uses editing terminology for common timeline actions',()=>{
  expect(ru['app.title']).toBe('WeftCut');
  expect(ru['app.window_title']).toBe('WeftCut — {{name}}');
  expect(ru['connect.agent_prompt_stdio']).toContain('ELECTRON_RUN_AS_NODE=1, WEFTCUT_USERDATA={{userData}}');
  expect(ru['connect.agent_prompt_skill']).toContain('~/.claude/skills/weftcut');
  expect(ru['connect.hint.codex']).toContain('~/.codex/config.toml');
  expect(ru['actions.nudge_back']).toBe('Сдвинуть раньше');
  expect(ru['keyframe.nav_next']).toBe('Следующий ключевой кадр');
  expect(ru['dock_workspace.panels.shots']).toBe('Сцены');
  expect(ru['effects.chromakey.params.feather']).toBe('Растушёвка края');
 });
});

it('names dismissal of the finished export dialog as closing, not leaving the project', () => {
  expect(ruRU.export.dismiss).toBe('Закрыть');
});
