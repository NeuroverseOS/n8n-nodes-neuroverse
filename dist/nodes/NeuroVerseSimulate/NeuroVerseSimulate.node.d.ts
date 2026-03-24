import { IExecuteFunctions, ILoadOptionsFunctions, INodeExecutionData, INodePropertyOptions, INodeType, INodeTypeDescription } from 'n8n-workflow';
export declare class NeuroVerseSimulate implements INodeType {
    description: INodeTypeDescription;
    methods: {
        loadOptions: {
            getCustomWorldChoices(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]>;
        };
    };
    execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]>;
}
//# sourceMappingURL=NeuroVerseSimulate.node.d.ts.map