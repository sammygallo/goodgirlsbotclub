// I/O commands: /echo, /pass, /setinput, /input, /popup, /buttons

import { registerCommand } from '../registry';
import type { ParsedArg } from '../types';

function getUnnamedArgs(args: ParsedArg[]): string {
  return args.filter(a => !a.key).map(a => a.value).join(' ');
}

function getNamedArg(args: ParsedArg[], key: string): string | undefined {
  return args.find(a => a.key === key)?.value;
}

registerCommand({
  name: 'echo',
  description: 'Display a toast notification',
  category: 'io',
  usage: '/echo [severity=info|warning|error|success] message',
  handler(args, rawArgs, ctx) {
    const severity = getNamedArg(args, 'severity');
    const variant = (['info', 'warning', 'error', 'success'] as const).find(v => v === severity) ?? 'info';
    const message = args.filter(a => a.key !== 'severity' && !a.key).map(a => a.value).join(' ') || rawArgs;
    ctx.showToast(message, variant);
    return message;
  },
});

registerCommand({
  name: 'pass',
  description: 'Pass a value to the pipe without side effects',
  category: 'io',
  usage: '/pass value',
  handler(args, rawArgs) {
    return getUnnamedArgs(args) || rawArgs;
  },
});

registerCommand({
  name: 'setinput',
  description: 'Set the chat input text',
  category: 'io',
  usage: '/setinput text',
  handler(args, rawArgs, ctx) {
    const text = getUnnamedArgs(args) || rawArgs;
    ctx.setInputText(text);
    return '';
  },
});

registerCommand({
  name: 'input',
  description: 'Show an input dialog and return user text',
  category: 'io',
  usage: '/input [default=value] prompt',
  async handler(args, rawArgs, ctx) {
    const defaultValue = getNamedArg(args, 'default') ?? '';
    const message = args.filter(a => a.key !== 'default' && !a.key).map(a => a.value).join(' ') || rawArgs;
    const result = await ctx.showInputPrompt(message, defaultValue);
    return result ?? '';
  },
});

registerCommand({
  name: 'popup',
  description: 'Show a popup message',
  category: 'io',
  usage: '/popup message',
  async handler(args, rawArgs, ctx) {
    const message = getUnnamedArgs(args) || rawArgs;
    await ctx.showPopup(message);
    return 'ok';
  },
});

registerCommand({
  name: 'buttons',
  description: 'Show a button selection popup',
  category: 'io',
  usage: '/buttons labels=["A","B","C"] message',
  async handler(args, rawArgs, ctx) {
    const labelsRaw = getNamedArg(args, 'labels');
    let buttons: string[] = ['OK'];
    if (labelsRaw) {
      try { buttons = JSON.parse(labelsRaw); } catch { /* use default */ }
    }
    const message = args.filter(a => a.key !== 'labels' && !a.key).map(a => a.value).join(' ') || rawArgs;
    const chosen = await ctx.showPopup(message, buttons);
    return chosen;
  },
});
