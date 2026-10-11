import {MCP_PROTOCOL_VERSION} from '../../dist/mcp.js';
export function recoveryMcpRequest(origin,path,method,params={},headers={}){
  return new Request(origin+path,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':MCP_PROTOCOL_VERSION,'mcp-method':method,...(method==='tools/call'?{'mcp-name':params.name}:{}),...headers},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{...params,_meta:{'io.modelcontextprotocol/protocolVersion':MCP_PROTOCOL_VERSION,'io.modelcontextprotocol/clientCapabilities':{},'io.modelcontextprotocol/clientInfo':{name:'owned-native-recovery-test',version:'1.0.0'}}}})});
}
