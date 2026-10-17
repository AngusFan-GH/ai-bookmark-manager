import { createApp } from 'vue';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import '../../src/ui/theme.css';
import './popup.css';
import App from './App.vue';
createApp(App).use(ElementPlus).mount('#app');
