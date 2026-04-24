import { render } from 'preact';
import { App } from './App.js';

const root = document.getElementById('root');
if (!root) throw new Error('root element missing');
render(<App />, root);
