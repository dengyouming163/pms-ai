const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, 'src');

function fixImports(filePath) {
    let content = fs.readFileSync(filePath, 'utf-8');
    
    // 计算文件深度
    const relativePath = path.relative(srcDir, filePath);
    const depth = relativePath.split(path.sep).length - 1; // 减去文件名
    
    // 根据深度计算正确的路径前缀
    let prefix = '../'.repeat(depth);
    
    // 移除所有旧的路径前缀，然后添加正确的前缀
    content = content.replace(/from '(\.\.\/)+(src\/)?stores/g, "from '" + prefix + "stores");
    content = content.replace(/from "(\.\.\/)+(src\/)?stores/g, 'from "' + prefix + "stores");
    
    content = content.replace(/from '(\.\.\/)+(src\/)?api\/modules/g, "from '" + prefix + "api/modules");
    content = content.replace(/from "(\.\.\/)+(src\/)?api\/modules/g, 'from "' + prefix + "api/modules");
    
    content = content.replace(/from '(\.\.\/)+(src\/)?components/g, "from '" + prefix + "components");
    content = content.replace(/from "(\.\.\/)+(src\/)?components/g, 'from "' + prefix + "components");
    
    content = content.replace(/from '(\.\.\/)+(src\/)?composables/g, "from '" + prefix + "composables");
    content = content.replace(/from "(\.\.\/)+(src\/)?composables/g, 'from "' + prefix + "composables");
    
    content = content.replace(/from '(\.\.\/)+(src\/)?types/g, "from '" + prefix + "types");
    content = content.replace(/from "(\.\.\/)+(src\/)?types/g, 'from "' + prefix + "types");
    
    fs.writeFileSync(filePath, content, 'utf-8');
    console.log(`Fixed (depth ${depth}): ${filePath}`);
}

function processDir(dir) {
    const files = fs.readdirSync(dir);
    
    for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        
        if (stat.isDirectory()) {
            processDir(fullPath);
        } else if (stat.isFile() && file.endsWith('.vue')) {
            fixImports(fullPath);
        }
    }
}

processDir(path.join(srcDir, 'pages'));