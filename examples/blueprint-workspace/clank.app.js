export default {
    name: "Delivery Workspace",
    slug: "delivery-workspace",
    description: "Projects with related live tasks, retained notes, release gates, and exact agent actions.",
    auth: {
        required: true,
        roles: {
            owner: {
                description: "Owns delivery settings and destructive actions.",
                permissions: [
                    "projects.*",
                    "tasks.*",
                    "notes.*",
                    "gates.*"
                ]
            },
            member: {
                description: "Creates and updates delivery work.",
                permissions: [
                    "projects.read",
                    "projects.create",
                    "tasks.*",
                    "notes.*"
                ]
            }
        }
    },
    entities: {
        projects: {
            description: "Top-level delivery projects.",
            ownership: "user",
            realtime: true,
            displayField: "name",
            fields: {
                name: {
                    type: "string",
                    description: "A short, recognizable project name.",
                    min: 1,
                    max: 100
                }
            }
        },
        tasks: {
            description: "Live work that is deleted with its project.",
            ownership: "user",
            realtime: true,
            displayField: "title",
            completionField: "done",
            fields: {
                title: {
                    type: "string",
                    min: 1,
                    max: 200
                },
                done: {
                    type: "boolean",
                    default: false
                },
                priority: {
                    type: "enum",
                    values: [
                        "low",
                        "normal",
                        "high"
                    ],
                    default: "normal"
                },
                projectId: {
                    type: "reference",
                    entity: "projects",
                    description: "The project that owns this work."
                }
            },
            indexes: {
                by_project: {
                    fields: [
                        "projectId"
                    ]
                },
                by_done: {
                    fields: [
                        "done"
                    ]
                }
            }
        },
        notes: {
            description: "Request/response notes retained if their project is removed.",
            ownership: "user",
            realtime: false,
            displayField: "body",
            fields: {
                body: {
                    type: "text",
                    min: 1,
                    max: 2000
                },
                projectId: {
                    type: "reference",
                    entity: "projects",
                    nullable: true
                }
            },
            indexes: {
                by_project: {
                    fields: [
                        "projectId"
                    ]
                }
            }
        },
        gates: {
            description: "Release gates that explicitly restrict project deletion.",
            ownership: "user",
            realtime: true,
            displayField: "title",
            fields: {
                title: {
                    type: "string",
                    min: 1,
                    max: 100
                },
                projectId: {
                    type: "reference",
                    entity: "projects"
                }
            },
            indexes: {
                by_project: {
                    fields: [
                        "projectId"
                    ]
                }
            }
        }
    },
    relationships: [
        {
            name: "projectTasks",
            from: "projects",
            to: "tasks",
            kind: "one-to-many",
            onDelete: "cascade",
            reference: {
                entity: "tasks",
                field: "projectId"
            }
        },
        {
            name: "projectNotes",
            from: "projects",
            to: "notes",
            kind: "one-to-many",
            onDelete: "nullify",
            reference: {
                entity: "notes",
                field: "projectId"
            }
        },
        {
            name: "projectGates",
            from: "projects",
            to: "gates",
            kind: "one-to-many",
            onDelete: "restrict",
            reference: {
                entity: "gates",
                field: "projectId"
            }
        }
    ],
    routes: [
        {
            path: "/",
            view: "Projects",
            description: "Create and review delivery projects.",
            entity: "projects",
            access: {
                roles: [
                    "owner",
                    "member"
                ]
            }
        },
        {
            path: "/tasks",
            view: "Tasks",
            description: "Manage live project tasks.",
            entity: "tasks",
            access: "authenticated"
        },
        {
            path: "/notes",
            view: "Notes",
            description: "Manage retained project notes.",
            entity: "notes",
            access: "authenticated"
        },
        {
            path: "/gates",
            view: "ReleaseGates",
            description: "Manage explicit release blockers.",
            entity: "gates",
            access: {
                roles: [
                    "owner"
                ]
            }
        },
        {
            path: "/about",
            view: "About",
            description: "This information-only route was generated directly from the blueprint.",
            access: "authenticated"
        }
    ],
    actions: {
        "projects.view": {
            description: "List projects visible to the signed-in person.",
            entity: "projects",
            operation: "read",
            roles: [
                "owner",
                "member"
            ]
        },
        "projects.create": {
            description: "Create a project.",
            entity: "projects",
            operation: "create",
            roles: [
                "owner",
                "member"
            ]
        },
        "projects.rename": {
            description: "Change project fields with optimistic concurrency.",
            entity: "projects",
            operation: "update",
            behavior: "update",
            roles: [
                "owner"
            ]
        },
        "projects.delete": {
            description: "Delete a project after applying every relationship policy.",
            entity: "projects",
            operation: "delete",
            roles: [
                "owner"
            ],
            confirmation: "always"
        },
        "tasks.view": {
            description: "List tasks visible to the signed-in person.",
            entity: "tasks",
            operation: "read"
        },
        "tasks.add": {
            description: "Create a task in a visible project.",
            entity: "tasks",
            operation: "create"
        },
        "tasks.complete": {
            description: "Complete or reopen a task.",
            entity: "tasks",
            operation: "update",
            behavior: "toggle",
            realtime: true
        },
        "tasks.edit": {
            description: "Change task fields with optimistic concurrency.",
            entity: "tasks",
            operation: "update",
            behavior: "update"
        },
        "tasks.delete": {
            description: "Permanently delete a task.",
            entity: "tasks",
            operation: "delete",
            confirmation: "always"
        }
    },
    services: {
        notifications: {
            kind: "email",
            description: "Optional delivery notifications.",
            required: false,
            capabilities: [
                "send"
            ]
        }
    },
    deployment: {
        database: "sqlite",
        scale: "single",
        isolation: "container",
        healthPath: "/healthz",
        customDomains: true
    }
};


//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi9ob21lL25lYXJieS9TaXRlcy9jbGFuay9leGFtcGxlcy9ibHVlcHJpbnQtd29ya3NwYWNlL2NsYW5rLmFwcC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxlQUFlO0lBQ2IsTUFBTTtJQUNOLE1BQU07SUFDTixhQUFhO0lBQ2IsTUFBTTtRQUNKLFVBQVU7UUFDVixPQUFPO1lBQ0wsT0FBTztnQkFDTCxhQUFhO2dCQUNiLGFBQWE7b0JBQUM7b0JBQWM7b0JBQVc7b0JBQVc7aUJBQVU7WUFDOUQ7WUFDQSxRQUFRO2dCQUNOLGFBQWE7Z0JBQ2IsYUFBYTtvQkFBQztvQkFBaUI7b0JBQW1CO29CQUFXO2lCQUFVO1lBQ3pFO1FBQ0Y7SUFDRjtJQUNBLFVBQVU7UUFDUixVQUFVO1lBQ1IsYUFBYTtZQUNiLFdBQVc7WUFDWCxVQUFVO1lBQ1YsY0FBYztZQUNkLFFBQVE7Z0JBQ04sTUFBTTtvQkFDSixNQUFNO29CQUNOLGFBQWE7b0JBQ2IsS0FBSztvQkFDTCxLQUFLO2dCQUNQO1lBQ0Y7UUFDRjtRQUNBLE9BQU87WUFDTCxhQUFhO1lBQ2IsV0FBVztZQUNYLFVBQVU7WUFDVixjQUFjO1lBQ2QsaUJBQWlCO1lBQ2pCLFFBQVE7Z0JBQ04sT0FBTztvQkFBRSxNQUFNO29CQUFVLEtBQUs7b0JBQUcsS0FBSztnQkFBSTtnQkFDMUMsTUFBTTtvQkFBRSxNQUFNO29CQUFXLFNBQVM7Z0JBQU07Z0JBQ3hDLFVBQVU7b0JBQ1IsTUFBTTtvQkFDTixRQUFRO3dCQUFDO3dCQUFPO3dCQUFVO3FCQUFPO29CQUNqQyxTQUFTO2dCQUNYO2dCQUNBLFdBQVc7b0JBQ1QsTUFBTTtvQkFDTixRQUFRO29CQUNSLGFBQWE7Z0JBQ2Y7WUFDRjtZQUNBLFNBQVM7Z0JBQ1AsWUFBWTtvQkFBRSxRQUFRO3dCQUFDO3FCQUFZO2dCQUFDO2dCQUNwQyxTQUFTO29CQUFFLFFBQVE7d0JBQUM7cUJBQU87Z0JBQUM7WUFDOUI7UUFDRjtRQUNBLE9BQU87WUFDTCxhQUFhO1lBQ2IsV0FB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